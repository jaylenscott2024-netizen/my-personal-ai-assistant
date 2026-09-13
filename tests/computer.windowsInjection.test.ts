import { describe, it, expect, vi, beforeEach } from "vitest";

// These verify the actual PowerShell command STRINGS built for the
// Windows code paths, which is the only way to catch a command-injection
// regression: none of this environment's other computer-control tests
// run on Windows, so a broken escape here would otherwise ship silently.
// child_process is mocked rather than exercised for real — there is no
// PowerShell in this sandbox.

const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
  const callback = typeof _opts === "function" ? (_opts as typeof cb) : cb;
  callback?.(null, { stdout: "0", stderr: "" });
});

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/computer/platform.js", () => ({
  currentPlatform: () => "windows",
}));

beforeEach(() => {
  execFileMock.mockClear();
});

function lastPowershellCommand(): string {
  const call = execFileMock.mock.calls.find((c) => c[0] === "powershell.exe");
  if (!call) throw new Error("powershell.exe was never invoked");
  const args = call[1] as string[];
  const commandIndex = args.indexOf("-Command");
  return args[commandIndex + 1];
}

describe("closeApplication — Windows PowerShell injection guard", () => {
  it("escapes an embedded single quote so it cannot break out of the string literal", async () => {
    const { closeApplication } = await import("../src/computer/appLauncher.js");
    await closeApplication("notepad'; Remove-Item -Recurse -Force C:\\ ; '");

    const command = lastPowershellCommand();
    // The literal must contain the escaped '' form, not a bare ' that
    // would terminate the string early — and the whole escaped payload
    // must still sit inside the single `'*...*'` -like literal rather
    // than having closed it partway through.
    expect(command).toContain("notepad''; Remove-Item -Recurse -Force C:\\ ; ''");
    expect(command).toContain("'*notepad''; Remove-Item -Recurse -Force C:\\ ; ''*'");
  });

  it("still builds a working command for an ordinary process name", async () => {
    const { closeApplication } = await import("../src/computer/appLauncher.js");
    await closeApplication("notepad");

    const command = lastPowershellCommand();
    expect(command).toContain("'*notepad*'");
  });
});

describe("inputControl mouse actions — Windows P/Invoke shim", () => {
  it("click() sends a left-button down/up pair via mouse_event, not just cursor positioning", async () => {
    const { click } = await import("../src/computer/inputControl.js");
    await click(100, 200, "left");

    const command = lastPowershellCommand();
    expect(command).toContain("New-Object System.Drawing.Point(100,200)");
    expect(command).toContain("mouse_event(2, 0, 0, 0"); // MOUSEEVENTF_LEFTDOWN
    expect(command).toContain("mouse_event(4, 0, 0, 0"); // MOUSEEVENTF_LEFTUP
  });

  it("click() with button:right uses the right-button flags", async () => {
    const { click } = await import("../src/computer/inputControl.js");
    await click(10, 10, "right");

    const command = lastPowershellCommand();
    expect(command).toContain("mouse_event(8, 0, 0, 0"); // MOUSEEVENTF_RIGHTDOWN
    expect(command).toContain("mouse_event(16, 0, 0, 0"); // MOUSEEVENTF_RIGHTUP
  });

  it("doubleClick() issues two full click sequences", async () => {
    const { doubleClick } = await import("../src/computer/inputControl.js");
    await doubleClick(5, 5);

    const command = lastPowershellCommand();
    const downCount = (command.match(/mouse_event\(2, /g) ?? []).length;
    expect(downCount).toBe(2);
  });

  it("scroll() encodes a negative delta as its unsigned 32-bit representation", async () => {
    const { scroll } = await import("../src/computer/inputControl.js");
    await scroll(0, 0, -1);

    const command = lastPowershellCommand();
    // -120 as uint32 is 4294967176 — PowerShell's uint parameter cannot
    // accept a bare negative literal, so this must appear instead.
    expect(command).toContain("4294967176");
  });

  it("drag() presses down at the origin, moves, then releases at the destination", async () => {
    const { drag } = await import("../src/computer/inputControl.js");
    await drag(1, 2, 300, 400);

    const command = lastPowershellCommand();
    const originIdx = command.indexOf("Point(1,2)");
    const downIdx = command.indexOf("mouse_event(2, ");
    const destIdx = command.indexOf("Point(300,400)");
    const upIdx = command.indexOf("mouse_event(4, ");
    expect(originIdx).toBeGreaterThan(-1);
    expect(originIdx).toBeLessThan(downIdx);
    expect(downIdx).toBeLessThan(destIdx);
    expect(destIdx).toBeLessThan(upIdx);
  });
});
