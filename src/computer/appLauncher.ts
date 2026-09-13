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
      // Fallback for entries where AppID is actually a plain executable path.
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${app.launchTarget}'`], { timeout: 15_000 });
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

export async function closeApplication(query: string): Promise<{ closed: boolean; matchedProcesses: number }> {
  const platform = currentPlatform();
  const processNameHint = query.trim();
  if (!processNameHint) throw new ValidationError("An application name is required.");

  if (platform === "windows") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Get-Process | Where-Object { $_.ProcessName -like '*${processNameHint}*' } | Stop-Process -Force -PassThru | Measure-Object | Select-Object -ExpandProperty Count`],
      { timeout: 15_000 },
    );
    const count = parseInt(stdout.trim(), 10) || 0;
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
