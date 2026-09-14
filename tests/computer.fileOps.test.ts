import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFolder, moveFile, copyFile, deleteFile, assertSafePath } from "../src/computer/fileOps.js";
import { ValidationError } from "../src/utils/errors.js";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-fileops-test-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

// Unlike the sandboxed filesystem tool, computer file ops operate on the
// user's real desktop paths (Downloads, Desktop, etc.) — safety here comes
// from blocking a fixed list of OS-critical paths, not a single allowed
// root. These tests exercise real fs operations, not mocks.
describe("computer file operations", () => {
  it("creates a folder, including missing parents", async () => {
    const target = path.join(workDir, "Projects", "Nested");
    const result = await createFolder(target);
    expect(result.created).toBe(path.resolve(target));
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it("moves a file", async () => {
    const src = path.join(workDir, "source.txt");
    await fs.writeFile(src, "hello");
    const dest = path.join(workDir, "moved", "source.txt");

    await moveFile(src, dest);
    expect(await fs.readFile(dest, "utf8")).toBe("hello");
    await expect(fs.stat(src)).rejects.toThrow();
  });

  it("copies a file, leaving the original in place", async () => {
    const src = path.join(workDir, "original.txt");
    await fs.writeFile(src, "keep me");
    const dest = path.join(workDir, "copy.txt");

    await copyFile(src, dest);
    expect(await fs.readFile(dest, "utf8")).toBe("keep me");
    expect(await fs.readFile(src, "utf8")).toBe("keep me");
  });

  it("copies a directory recursively", async () => {
    const srcDir = path.join(workDir, "srcdir");
    await fs.mkdir(srcDir);
    await fs.writeFile(path.join(srcDir, "a.txt"), "a");
    const destDir = path.join(workDir, "destdir");

    await copyFile(srcDir, destDir);
    expect(await fs.readFile(path.join(destDir, "a.txt"), "utf8")).toBe("a");
  });

  it("deletes a file", async () => {
    const target = path.join(workDir, "to-delete.txt");
    await fs.writeFile(target, "bye");
    await deleteFile(target);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("refuses to operate on operating-system-critical paths", () => {
    // These POSIX-style critical paths must be rejected regardless of
    // which platform this actually runs on: assertSafePath checks the
    // raw, pre-resolution input against both POSIX- and Windows-style
    // dangerous prefixes specifically so this invariant doesn't depend
    // on path.resolve()'s platform-native behavior (on Windows,
    // path.resolve("/etc/passwd") resolves relative to the current
    // drive, producing something that no longer starts with "/etc" at
    // all — a check that only looked at the resolved path would miss
    // this entirely).
    expect(() => assertSafePath("/usr/bin/something")).toThrow(ValidationError);
    expect(() => assertSafePath("/etc/passwd")).toThrow(ValidationError);
  });

  it("refuses windows-style critical paths regardless of the host platform", () => {
    expect(() => assertSafePath("C:\\Windows\\System32\\config\\SAM")).toThrow(ValidationError);
    expect(() => assertSafePath("C:\\Program Files\\Vendor\\app.exe")).toThrow(ValidationError);
  });

  it("allows ordinary user paths", () => {
    expect(() => assertSafePath(path.join(workDir, "notes.txt"))).not.toThrow();
  });

  it("expands a leading ~ to the home directory", () => {
    const resolved = assertSafePath("~/some-file.txt");
    expect(resolved).toBe(path.resolve(os.homedir(), "some-file.txt"));
  });
});
