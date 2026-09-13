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
  // The Eyes tools' declared permission (computer.eyes.read) covers their
  // structural/temporal summaries; anything that puts actual pixels in
  // front of the model is a fundamentally higher-risk operation (a screen
  // can show anything), so the stricter computer.eyes.capture permission —
  // and the approval it triggers via riskLevelForPermissions — applies
  // whenever the caller asked for imagery. This covers both capturing a
  // fresh frame and surfacing keyframes already held in memory: the risk
  // is the model seeing the pixels, not when they were taken.
  if ((toolName === "eyes_get_visual_state" || toolName === "eyes_query_visual_history") && input.includeVisual === true) {
    return [...declared, "computer.eyes.capture"];
  }
  return declared;
}
