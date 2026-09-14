import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentPlatform } from "./platform.js";
import { discoverApplications, matchApplications, type DiscoveredApp } from "./appDiscovery.js";
import { ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

export interface LaunchResult {
  launched: boolean;
  app: DiscoveredApp;
}

export interface AmbiguousMatchResult {
  ambiguous: true;
  candidates: Array<{ name: string; id: string }>;
}

// Section 3/4: resolve "Blender" to an installed application and actually
// launch it — never a hard-coded name-to-executable map. Detached so the
// launched application isn't a child process tied to this backend's
// lifetime (closing Jarvis shouldn't close everything it opened).
export async function openApplication(query: string): Promise<LaunchResult | AmbiguousMatchResult> {
  const apps = await discoverApplications();
  const matches = matchApplications(query, apps);

  if (matches.length === 0) {
    throw new ValidationError(`No installed application matching "${query}" was found.`);
  }

  // A clear winner: exact/prefix match meaningfully ahead of the runner-up.
  const [best, second] = matches;
  const unambiguous = matches.length === 1 || best.score >= 80 || best.score - (second?.score ?? 0) >= 30;

  if (!unambiguous) {
    return { ambiguous: true, candidates: matches.map((m) => ({ name: m.app.name, id: m.app.id })) };
  }

  await launchByTarget(best.app);
  return { launched: true, app: best.app };
}

async function launchByTarget(app: DiscoveredApp): Promise<void> {
  const platform = currentPlatform();

  if (platform === "windows") {
    // shell:AppsFolder resolves both UWP and classic Win32 AppIDs correctly.
    await execFileAsync("explorer.exe", [`shell:AppsFolder\\${app.launchTarget}`], { timeout: 15_000 }).catch(async () => {
      // Fallback for entries where AppID is actually a plain executable
      // path. app.launchTarget is system-derived (discoverApplications),
      // not directly attacker-controlled, but it is still escaped before
      // entering a PowerShell string literal as defense in depth.
      const escaped = app.launchTarget.replace(/'/g, "''");
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${escaped}'`], { timeout: 15_000 });
    });
    return;
  }

  if (platform === "macos") {
    await execFileAsync("open", ["-a", app.launchTarget], { timeout: 15_000 });
    return;
  }

  // Linux: the cleaned Exec= command may include arguments; spawn via a
  // shell so those are honored the same way a desktop launcher would.
  const child = spawn(app.launchTarget, { shell: true, detached: true, stdio: "ignore" });
  child.unref();
}

// Runs a PowerShell -Command script that's expected to print a single
// integer to stdout, returning that integer. execFile rejects on any
// non-zero exit code from powershell.exe itself — which is not the same
// thing as "the script's own logic failed," and has been observed to
// happen on real Windows PowerShell 5.1 even after the script already
// computed and printed a correct count. Node's execFile error objects
// still carry whatever stdout was captured before the process exited,
// so the count is recovered from there on a caught error too, rather
// than the process's own exit code being treated as the source of
// truth. Only falls back to 0 when stdout truly has no usable number
// (the script never ran at all, e.g. powershell.exe itself is missing).
async function runPowerShellForCount(script: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 15_000 });
    return parseInt(stdout.trim(), 10) || 0;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? "";
    return parseInt(stdout.trim(), 10) || 0;
  }
}

export async function closeApplication(query: string): Promise<{ closed: boolean; matchedProcesses: number }> {
  const platform = currentPlatform();
  const processNameHint = query.trim();
  if (!processNameHint) throw new ValidationError("An application name is required.");

  if (platform === "windows") {
    // processNameHint is a free-form, model-suppliable tool argument, not
    // a system-derived value — it MUST be escaped before entering a
    // PowerShell string literal. Without this, a name like
    // `x' }; Remove-Item -Recurse -Force C:\ ; '` would break out of the
    // quoted literal and run arbitrary PowerShell, with no approval gate
    // in the way (computer_close_application is requiresApproval: false).
    const escaped = processNameHint.replace(/'/g, "''");
    // Matches against BOTH the bare process/image name (ProcessName,
    // e.g. "notepad") AND the full command line (CommandLine, via
    // Get-CimInstance Win32_Process — Get-Process alone exposes only the
    // former). Matching only the bare name is not equivalent to
    // Linux/macOS's `pkill -f`, which searches the full command line
    // including arguments — a caller asking to close whatever process
    // was launched with a distinguishing argument (not just image name)
    // would silently find nothing under name-only matching, even though
    // a real matching process is running. CommandLine can come back
    // null for a process the current user doesn't own (access denied),
    // in which case that process is still reachable via the Name match.
    //
    // The whole body is wrapped in its own try/catch, with $count
    // assigned unconditionally at the top: on real Windows PowerShell
    // 5.1, Get-CimInstance/Stop-Process can leave the *process itself*
    // (powershell.exe) exiting with a non-zero code even after the
    // count was already correctly computed and printed — an unrelated
    // CIM/WMI provider hiccup, an already-exited target process,
    // per-process access errors, etc. -ErrorAction SilentlyContinue on
    // Stop-Process only suppresses that one cmdlet's own error record;
    // it does not guarantee the whole -Command invocation exits 0. This
    // script-level try/catch ensures a clean, always-numeric stdout
    // (falling back to 0) regardless of what goes wrong internally,
    // rather than letting an unrelated error corrupt or block the one
    // signal (the match count) this function actually depends on.
    const script = `$count = 0; try { $m = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -like '*${escaped}*' -or $_.CommandLine -like '*${escaped}*' }); foreach ($p in $m) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }; $count = $m.Count } catch {}; $count`;
    const count = await runPowerShellForCount(script);
    return { closed: count > 0, matchedProcesses: count };
  }

  if (platform === "macos") {
    try {
      await execFileAsync("pkill", ["-i", processNameHint], { timeout: 10_000 });
      return { closed: true, matchedProcesses: 1 };
    } catch {
      return { closed: false, matchedProcesses: 0 };
    }
  }

  try {
    await execFileAsync("pkill", ["-if", processNameHint], { timeout: 10_000 });
    return { closed: true, matchedProcesses: 1 };
  } catch {
    return { closed: false, matchedProcesses: 0 };
  }
}
