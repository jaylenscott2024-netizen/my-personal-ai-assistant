import type { Permission } from "./permissions.js";
import { accessLevelOf } from "./permissions.js";

// Section 16/18: least-privilege permission grants. This is a personal
// single-owner assistant by default (Section 1), so the practical policy
// is: the owner/admin role holds every permission a configured tool might
// need, while a "member" role (future multi-user households/teams) is
// read-only unless explicitly elevated. This is intentionally simple and
// documented as a v1 policy in SECURITY.md — the important invariant it
// upholds today is the one downstream code depends on: holding a
// permission is necessary but never sufficient for a risky action, because
// the approval engine (approvals/approvalService.ts) still gates anything
// above "read" regardless of role.
const ROLE_PERMISSIONS: Record<string, "all" | Permission[]> = {
  owner: "all",
  admin: "all",
  member: [], // granted read-only access levels dynamically, see hasPermission
};

export function hasPermission(role: string, permission: Permission): boolean {
  const grant = ROLE_PERMISSIONS[role];
  if (grant === "all") return true;
  if (Array.isArray(grant) && grant.includes(permission)) return true;
  // members get read-only tools without explicit grants
  return accessLevelOf(permission) === "read";
}

export function missingPermissions(role: string, required: Permission[]): Permission[] {
  return required.filter((p) => !hasPermission(role, p));
}
