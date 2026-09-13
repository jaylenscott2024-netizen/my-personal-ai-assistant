import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { closeApplication } from "../src/computer/appLauncher.js";

let dummyProcess: ChildProcess | undefined;

afterEach(() => {
  dummyProcess?.kill("SIGKILL");
  dummyProcess = undefined;
});

// closeApplication shells out to `pkill` on Linux/macOS — this test spawns
// a real long-running process under a distinctive name and verifies
// closeApplication genuinely terminates it, rather than mocking the
// process-management layer.
describe("closeApplication (Linux)", () => {
  it("terminates a real running process matching the given name", async () => {
    const marker = `jarvis-test-dummy-${Date.now()}`;
    // Spawn Node directly (not `bash -c "sleep ... # marker"`) — bash's
    // single-command tail-call optimization execs straight into `sleep`,
    // replacing its own argv and silently dropping any marker that isn't
    // part of `sleep`'s own arguments. Passing the marker as a genuine
    // trailing argv entry to a long-lived node process keeps it in the
    // running process's real cmdline for `pkill -f` to match.
    dummyProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", marker], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => dummyProcess!.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200)); // let it register

    const result = await closeApplication(marker);
    expect(result.closed).toBe(true);

    // Note: `dummyProcess.killed` only reflects a kill this same Node
    // process initiated via `child.kill()` — it stays false for a signal
    // delivered externally by `pkill`, which is exactly what
    // closeApplication does. The 'exit' event is what actually confirms
    // the OS terminated the process.
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("process did not exit")), 2000))]);
    expect(dummyProcess.exitCode !== null || dummyProcess.signalCode !== null).toBe(true);
  });

  it("reports closed:false when nothing matches", async () => {
    const result = await closeApplication(`nonexistent-app-${Date.now()}-xyz`);
    expect(result.closed).toBe(false);
  });
});
