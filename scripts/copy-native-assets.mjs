// Cross-platform replacement for `mkdir -p ... && cp ...`, which are
// Unix-only shell commands and don't exist in Windows cmd.exe/PowerShell.
// Uses only Node's fs module, so it behaves identically on every platform.
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const targetDir = join("dist", "eyes", "providers", "windows");
mkdirSync(targetDir, { recursive: true });
copyFileSync(join("src", "eyes", "providers", "windows", "eyesWatcher.ps1"), join(targetDir, "eyesWatcher.ps1"));
