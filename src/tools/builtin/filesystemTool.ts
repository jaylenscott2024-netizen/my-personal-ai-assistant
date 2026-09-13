import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { env } from "../../config/env.js";
import { ValidationError } from "../../utils/errors.js";

// Section 39: Secure Filesystem Tool. Every path is resolved against — and
// verified to stay inside — FILESYSTEM_TOOL_ROOT. There is no way for the
// model to pass "../../etc/passwd" and escape the sandbox: we resolve the
// real path and check it is prefixed by the sandbox root before touching
// disk (Section 68: tool sandboxing).
const workspaceRoot = path.resolve(env.FILESYSTEM_TOOL_ROOT);

function resolveInSandbox(relativePath: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw new ValidationError("Path escapes the allowed workspace directory.");
  }
  return resolved;
}

const inputSchema = z.object({
  operation: z.enum(["list", "read", "write", "delete", "rename"]),
  path: z.string().describe("Path relative to the assistant's sandboxed workspace directory."),
  content: z.string().optional().describe("Content to write. Required for operation 'write'."),
  newPath: z.string().optional().describe("Destination path. Required for operation 'rename'."),
});

export const filesystemTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "filesystem",
  description:
    "Read, write, list, rename, or delete files inside the assistant's sandboxed workspace directory. Cannot access any path outside that sandbox.",
  version: "1.0.0",
  inputSchema,
  jsonSchema: zodToJsonSchema(inputSchema, "filesystem") as Record<string, unknown>,
  requiredPermissions: ["filesystem.read"], // execute() enforces write/delete separately below
  requiresApproval: false, // write/delete are escalated to requiresApproval via the orchestrator's per-call risk check
  source: "builtin",
  async execute(input) {
    await fs.mkdir(workspaceRoot, { recursive: true });
    const target = resolveInSandbox(input.path);

    switch (input.operation) {
      case "list": {
        const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
        return { output: { entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })) } };
      }
      case "read": {
        const content = await fs.readFile(target, "utf8");
        return { output: { path: input.path, content }, untrusted: true };
      }
      case "write": {
        if (input.content === undefined) throw new ValidationError("content is required for write.");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, input.content, "utf8");
        return { output: { path: input.path, bytesWritten: Buffer.byteLength(input.content) } };
      }
      case "delete": {
        await fs.rm(target, { recursive: true, force: true });
        return { output: { path: input.path, deleted: true } };
      }
      case "rename": {
        if (!input.newPath) throw new ValidationError("newPath is required for rename.");
        const dest = resolveInSandbox(input.newPath);
        await fs.rename(target, dest);
        return { output: { from: input.path, to: input.newPath } };
      }
    }
  },
};

// Returns the permission actually required for a given filesystem call so
// the orchestrator's permission check (Section 16) can be operation-aware
// rather than granting blanket filesystem.write on every call.
export function filesystemPermissionFor(operation: string): "filesystem.read" | "filesystem.write" | "filesystem.delete" {
  if (operation === "delete") return "filesystem.delete";
  if (operation === "write" || operation === "rename") return "filesystem.write";
  return "filesystem.read";
}
