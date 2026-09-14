import { describe, it, expect, vi, beforeEach } from "vitest";

// discoverWindowsApps()'s own Get-StartApps JSON-parsing/mapping logic,
// and its filesystem-based Start Menu shortcut fallback, previously had
// zero test coverage at all — the only discoverApplications() path this
// sandbox can exercise for real is Linux's .desktop-file scan (see
// computer.appDiscovery.test.ts; that file's own header comment explains
// why Windows/macOS discovery can't be run for real here). child_process
// and node:fs/promises are mocked, following the same pattern
// computer.windowsInjection.test.ts already uses for Windows-only code
// paths, since there is no real PowerShell/Windows host in this sandbox.

const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
  const callback = typeof _opts === "function" ? (_opts as typeof cb) : cb;
  callback?.(null, { stdout: "[]", stderr: "" });
});

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/computer/platform.js", () => ({
  currentPlatform: () => "windows",
}));

const readdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: { readdir: (...args: unknown[]) => (readdirMock as (...a: unknown[]) => unknown)(...args) },
}));

beforeEach(() => {
  execFileMock.mockClear();
  readdirMock.mockReset();
  readdirMock.mockResolvedValue([]);
  vi.resetModules();
});

function mockPowerShellStdout(json: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const opts = args[2];
    const cb = args[3] as ((err: Error | null, res: { stdout: string; stderr: string }) => void) | undefined;
    const callback = typeof opts === "function" ? (opts as typeof cb) : cb;
    callback?.(null, { stdout: json, stderr: "" });
  });
}

describe("discoverApplications (Windows, mocked — no real PowerShell in this sandbox)", () => {
  it("parses Get-StartApps JSON output into DiscoveredApp entries", async () => {
    mockPowerShellStdout(
      JSON.stringify([
        { Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
        { Name: "Calculator", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
      ]),
    );
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications(true);
    expect(apps).toHaveLength(2);
    expect(apps.every((a) => a.source === "windows_start_apps")).toBe(true);
    expect(apps.map((a) => a.name)).toEqual(["Notepad", "Calculator"]);
    expect(apps[0].launchTarget).toBe("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App");
  });

  it("handles Get-StartApps returning a single (non-array) object", async () => {
    mockPowerShellStdout(JSON.stringify({ Name: "Notepad", AppID: "Notepad.exe" }));
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications(true);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Notepad");
  });

  it("filters out entries missing a Name or AppID", async () => {
    mockPowerShellStdout(JSON.stringify([{ Name: "Valid", AppID: "id-1" }, { Name: "NoAppId" }, { AppID: "id-2" }]));
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications(true);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Valid");
  });

  it("returns an empty list rather than throwing when Get-StartApps's output isn't valid JSON", async () => {
    mockPowerShellStdout("not json at all");
    readdirMock.mockResolvedValue([]);
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications(true);
    expect(apps).toEqual([]);
  });

  it("falls back to scanning Start Menu shortcut (.lnk) files when Get-StartApps returns nothing", async () => {
    mockPowerShellStdout("[]");
    readdirMock.mockImplementation(async (dir: unknown) => {
      if (typeof dir === "string" && dir.includes("ProgramData")) {
        return [
          { name: "Blender.lnk", isDirectory: () => false },
          { name: "readme.txt", isDirectory: () => false },
        ];
      }
      return [];
    });
    process.env.ProgramData = "C:\\ProgramData";
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications(true);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Blender");
    expect(apps[0].source).toBe("windows_start_apps");
    expect(apps[0].launchTarget).toContain("Blender.lnk");
  });

  it("does not fall back to the shortcut scan when Get-StartApps already found real applications", async () => {
    mockPowerShellStdout(JSON.stringify([{ Name: "Notepad", AppID: "Notepad.exe" }]));
    readdirMock.mockResolvedValue([{ name: "Ignored.lnk", isDirectory: () => false }]);
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications(true);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Notepad");
    expect(readdirMock).not.toHaveBeenCalled();
  });
});
