// Section 16/18: Tool Permissions & Security Model. Least-privilege
// permission strings that tools declare and the agent must be explicitly
// granted before a tool call is allowed to execute.

export const PERMISSIONS = [
  "filesystem.read",
  "filesystem.write",
  "filesystem.delete",
  "browser.read",
  "browser.interact",
  // Desktop/computer control (Section 3/8 of the Jarvis computer-control
  // spec). Deliberately split by risk tier rather than one blanket
  // "computer.control" permission, mirroring how filesystem/browser are
  // already split:
  //   computer.read     - list apps/windows, read screen/screenshot (LOW)
  //   computer.control   - open/close/focus an application (MEDIUM)
  //   computer.input     - keyboard/mouse control (MEDIUM)
  //   computer.files.*   - desktop file operations, unscoped from the
  //                        sandboxed filesystem tool's workspace root
  //   computer.execute   - run an arbitrary shell command (CRITICAL,
  //                        always allowlisted + approved, never bare)
  "computer.read",
  "computer.control",
  "computer.input",
  "computer.files.read",
  "computer.files.write",
  "computer.files.delete",
  "computer.execute",
  "email.read",
  "email.send",
  "calendar.read",
  "calendar.write",
  "shopify.read",
  "shopify.write",
  "github.read",
  "github.write",
  "phone.call",
  "network.fetch",
  "admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type AccessLevel = "read" | "write" | "execute" | "delete" | "send" | "purchase" | "call" | "admin";

// Maps a permission to the access level it represents, used purely for
// risk-scoring in the approval engine (Section 17/18).
export function accessLevelOf(permission: Permission): AccessLevel {
  if (permission === "computer.execute") return "admin"; // arbitrary command execution is as risky as admin
  if (permission.endsWith(".write")) return "write";
  if (permission.endsWith(".delete")) return "delete";
  if (permission.endsWith(".send")) return "send";
  if (permission === "phone.call") return "call";
  if (permission === "browser.interact" || permission === "computer.control" || permission === "computer.input") return "execute";
  if (permission === "admin") return "admin";
  return "read"; // covers filesystem.read, browser.read, computer.read, computer.files.read, network.fetch, *.read
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

// Default risk level for a set of required permissions — the approval
// engine may raise this per-tool (e.g. a purchase is always "critical").
export function riskLevelForPermissions(permissions: Permission[]): "low" | "medium" | "high" | "critical" {
  const levels = permissions.map(accessLevelOf);
  if (levels.includes("admin") || levels.includes("purchase")) return "critical";
  if (levels.includes("delete") || levels.includes("send") || levels.includes("call")) return "high";
  if (levels.includes("write") || levels.includes("execute")) return "medium";
  return "low";
}
