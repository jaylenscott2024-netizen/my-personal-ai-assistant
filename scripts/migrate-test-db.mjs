// Cross-platform replacement for:
//   DATABASE_URL="file:$(pwd)/prisma/test.db" npx prisma migrate deploy
// `VAR=value command` and `$(pwd)` are POSIX shell syntax and don't work in
// Windows cmd.exe or PowerShell. This computes the same absolute path with
// Node's path module (which resolves correctly on every platform) and
// passes it to the child process via an env object, which needs no shell
// assignment syntax at all.
import { spawnSync } from "node:child_process";
import path from "node:path";

// Prisma's SQLite connection strings require forward slashes even on
// Windows; path.resolve() returns backslash-separated paths there, so they
// are normalized before being embedded in the file: URL.
const absolutePath = path.resolve(process.cwd(), "prisma", "test.db").split(path.sep).join("/");
const databaseUrl = `file:${absolutePath}`;

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

process.exit(result.status ?? 1);
