import { describe, it, expect } from "vitest";
import path from "node:path";
import { browserPermissionFor, resolveSafeDownloadPath } from "../src/tools/builtin/browserTool.js";

// Section 6: browser tool actions are only "read" risk unless they
// actually mutate page state or move data in/out of the browser.
describe("browserPermissionFor", () => {
  it("treats read-only/navigational actions as browser.read", () => {
    for (const action of ["open", "navigate", "back", "forward", "read_page", "find", "screenshot", "wait", "close"]) {
      expect(browserPermissionFor(action)).toBe("browser.read");
    }
  });

  it("escalates mutating/interactive actions to browser.interact", () => {
    for (const action of ["click", "type", "select", "download", "upload"]) {
      expect(browserPermissionFor(action)).toBe("browser.interact");
    }
  });
});

// Regression coverage for a real path-traversal bug found in review: the
// download action joined a page-supplied Content-Disposition filename
// straight into the workspace root with plain path.join, which does not
// stop "../" segments from escaping it — a malicious or compromised page
// could write a file anywhere the process can write, with no approval
// gate in the way (browser_download only requires browser.interact).
describe("resolveSafeDownloadPath — the download path-traversal guard", () => {
  const root = "/workspace/data";

  it("keeps an ordinary filename inside the workspace root, unchanged", () => {
    const { safeName, destPath } = resolveSafeDownloadPath(root, "report.pdf");
    expect(safeName).toBe("report.pdf");
    expect(destPath).toBe(path.resolve(root, "report.pdf"));
  });

  it("strips a posix-style traversal payload down to its trailing filename", () => {
    const { safeName, destPath } = resolveSafeDownloadPath(root, "../../../etc/cron.d/evil");
    expect(safeName).toBe("evil");
    expect(destPath).toBe(path.resolve(root, "evil"));
    expect(destPath.startsWith(root)).toBe(true);
  });

  it("strips a windows-style traversal payload the same way", () => {
    const { safeName } = resolveSafeDownloadPath(root, "..\\..\\evil.exe");
    // On the platform this test actually runs on (posix), a backslash is
    // just a filename character to path.basename, not a separator — so
    // the whole string survives as one "filename." What matters for
    // safety either way: the result never contains a raw ".." path
    // segment capable of climbing directories once resolved.
    expect(safeName).not.toBe("..");
    expect(resolveSafeDownloadPath(root, "..\\..\\evil.exe").destPath.startsWith(root)).toBe(true);
  });

  it("rejects the bare '..' edge case basename cannot strip", () => {
    // ".." has no separator for path.basename to remove, so it survives
    // untouched — resolving it against root yields root's own PARENT.
    // This is exactly the case the boundary check (not basename alone)
    // has to catch.
    expect(() => resolveSafeDownloadPath(root, "..")).toThrow(/outside the assistant's workspace/i);
  });

  it("never produces a destPath outside the workspace root for any input", () => {
    const payloads = ["../secret", "../../../../root/.ssh/authorized_keys", "a/../../b", "....//....//etc/passwd"];
    for (const payload of payloads) {
      const { destPath } = resolveSafeDownloadPath(root, payload);
      expect(destPath === root || destPath.startsWith(root + path.sep)).toBe(true);
    }
  });
});
