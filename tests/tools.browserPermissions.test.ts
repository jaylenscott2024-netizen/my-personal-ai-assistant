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
  // resolveSafeDownloadPath resolves workspaceRoot via path.resolve()
  // before comparing anything against it, so its own internal boundary
  // check is already platform-correct. But path.resolve() is
  // platform-native: on Windows, a POSIX-style literal with no drive
  // letter like "/workspace/data" resolves relative to the current
  // drive (e.g. "C:\workspace\data"), not to the literal string
  // "/workspace/data". Assertions here compare against this SAME
  // resolved form — anything else would fail on Windows even when the
  // actual security invariant (destination stays inside the workspace
  // root) genuinely holds, and would silently stop verifying anything
  // real if it were "fixed" by weakening the comparison instead.
  const resolvedRoot = path.resolve(root);

  it("keeps an ordinary filename inside the workspace root, unchanged", () => {
    const { safeName, destPath } = resolveSafeDownloadPath(root, "report.pdf");
    expect(safeName).toBe("report.pdf");
    expect(destPath).toBe(path.resolve(root, "report.pdf"));
  });

  it("strips a posix-style traversal payload down to its trailing filename", () => {
    const { safeName, destPath } = resolveSafeDownloadPath(root, "../../../etc/cron.d/evil");
    expect(safeName).toBe("evil");
    expect(destPath).toBe(path.resolve(root, "evil"));
    expect(destPath.startsWith(resolvedRoot)).toBe(true);
  });

  it("strips a windows-style traversal payload the same way", () => {
    const { safeName, destPath } = resolveSafeDownloadPath(root, "..\\..\\evil.exe");
    // On POSIX, a backslash is just a filename character to
    // path.basename, not a separator, so the whole string survives as
    // one "filename" — still safe, since it's then treated as an
    // opaque (if odd-looking) filename rather than a path. On Windows,
    // path.basename is separator-aware for both "/" and "\\", so this
    // correctly strips down to "evil.exe" the same way the posix
    // payload above does. Either way, the result must never contain a
    // raw ".." path segment capable of climbing directories once
    // resolved, and the resolved destination must stay inside the root.
    expect(safeName).not.toBe("..");
    expect(destPath === resolvedRoot || destPath.startsWith(resolvedRoot + path.sep)).toBe(true);
  });

  it("rejects the bare '..' edge case basename cannot strip", () => {
    // ".." has no separator for path.basename to remove, so it survives
    // untouched — resolving it against root yields root's own PARENT.
    // This is exactly the case the boundary check (not basename alone)
    // has to catch.
    expect(() => resolveSafeDownloadPath(root, "..")).toThrow(/outside the assistant's workspace/i);
  });

  it("never produces a destPath outside the workspace root for any input", () => {
    // Covers posix traversal, mixed/obfuscated separators, an
    // already-absolute posix path with no ".." at all, a Windows
    // drive-relative reference (no separator — "C:foo" means "relative
    // to the current directory on drive C", not "C:\foo"), a UNC-style
    // path, and an already-absolute Windows path — every one of these
    // is a real shape a Content-Disposition filename could take.
    const payloads = [
      "../secret",
      "../../../../root/.ssh/authorized_keys",
      "a/../../b",
      "....//....//etc/passwd",
      "..\\..\\..\\Windows\\System32\\config\\SAM",
      "/etc/passwd",
      "C:evil.exe",
      "C:\\Windows\\System32\\evil.dll",
      "\\\\server\\share\\evil.exe",
    ];
    for (const payload of payloads) {
      const { destPath } = resolveSafeDownloadPath(root, payload);
      expect(destPath === resolvedRoot || destPath.startsWith(resolvedRoot + path.sep)).toBe(true);
    }
  });
});
