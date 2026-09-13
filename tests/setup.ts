import path from "node:path";

// Executed before any test file's imports resolve, so it must set process.env
// before anything (including our own env.ts) reads it.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.resolve(process.cwd(), "prisma/test.db")}`;
process.env.LOG_LEVEL = "silent";
process.env.FILESYSTEM_TOOL_ROOT = path.resolve(process.cwd(), "tests/.workspace");
process.env.DEFAULT_AI_PROVIDER = "mock";
process.env.AGENT_MAX_STEPS = "6";
process.env.AGENT_MAX_EXECUTION_MS = "20000";
process.env.AGENT_MAX_TOOL_CALLS = "10";
process.env.AGENT_APPROVAL_WAIT_MS = "400";
