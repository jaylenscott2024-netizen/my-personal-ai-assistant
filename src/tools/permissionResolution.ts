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
  // eyes_get_visual_state's declared permission (computer.eyes.read) covers
  // its always-on structural summary; actually capturing a pixel frame is a
  // fundamentally higher-risk operation (Section: pixel capture can contain
  // anything on screen), so the stricter computer.eyes.capture permission —
  // and the approval it triggers via riskLevelForPermissions — only applies
  // when the caller actually asked for includeVisual.
  if (toolName === "eyes_get_visual_state" && input.includeVisual === true) {
    return [...declared, "computer.eyes.capture"];
  }
  return declared;
}
