import path from "node:path";

// Executed before any test file's imports resolve, so it must set process.env
// before anything (including our own env.ts) reads it.
process.env.NODE_ENV = "test";
// Prisma's SQLite connection strings require forward slashes even on
// Windows; path.resolve() returns backslash-separated paths there, so they
// are normalized before being embedded in the file: URL.
process.env.DATABASE_URL = `file:${path.resolve(process.cwd(), "prisma/test.db").split(path.sep).join("/")}`;
process.env.LOG_LEVEL = "silent";
process.env.FILESYSTEM_TOOL_ROOT = path.resolve(process.cwd(), "tests/.workspace");
process.env.DEFAULT_AI_PROVIDER = "mock";
process.env.AGENT_MAX_STEPS = "6";
process.env.AGENT_MAX_EXECUTION_MS = "20000";
process.env.AGENT_MAX_TOOL_CALLS = "10";
process.env.AGENT_APPROVAL_WAIT_MS = "400";
// Fixed test allowlist — env.ts is a frozen singleton read once at import
// time, so tests can't toggle this per-case via process.env; see
// tests/computer.commandRunner.test.ts for how allow/deny is tested
// against this fixed set instead.
process.env.COMPUTER_COMMAND_ALLOWLIST = "echo,false";
