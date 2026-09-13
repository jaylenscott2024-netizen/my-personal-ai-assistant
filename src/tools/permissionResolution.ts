import type { Permission } from "../security/permissions.js";
import { filesystemPermissionFor } from "./builtin/filesystemTool.js";
import { browserPermissionFor } from "./builtin/browserTool.js";

// Some tools (filesystem, browser) declare a baseline permission but the
// actual risk depends on the specific call (reading a file vs. deleting
// one). This resolves the *effective* permission set for a concrete call so
// the permission check and approval engine see the real risk, not just the
// tool's most permissive declared capability.
export function resolveEffectivePermissions(toolName: string, input: Record<string, unknown>, declared: Permission[]): Permission[] {
  if (toolName === "filesystem" && typeof input.operation === "string") {
    return [filesystemPermissionFor(input.operation)];
  }
  if (toolName === "browser" && typeof input.action === "string") {
    return [browserPermissionFor(input.action)];
  }
  return declared;
}
