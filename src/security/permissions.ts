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
  // already split — and matching the spec's own explicit 3-tier
  // categorization exactly:
  //   LOW:    computer.read    - list apps/windows, read screen/screenshot
  //           computer.control - open/close/focus an application, open a
  //                              file/folder (the spec calls "open
  //                              application", "focus window", "open
  //                              folder" LOW risk — launching/focusing
  //                              something is easily reversible)
  //   MEDIUM: computer.input      - keyboard/mouse control (type, click)
  //           computer.files.write - create/move/copy a file
  //   HIGH:   computer.files.delete - delete a file
  //   CRITICAL: computer.execute    - run an arbitrary shell command
  //             (the spec calls this HIGH; treating it as CRITICAL here
  //             is a deliberately stricter read of "do not simply give
  //             the LLM unrestricted shell access" — it still gets the
  //             same approval requirement either way, since both HIGH and
  //             CRITICAL require approval below)
  "computer.read",
  "computer.control",
  "computer.input",
  "computer.files.read",
  "computer.files.write",
  "computer.files.delete",
  "computer.execute",
  // Jarvis Eyes (visual perception — see EYES.md). Split the same way as
  // computer.* above: structural/semantic awareness (window list, UI
  // Automation tree, peripheral event summaries — no pixel data) is a
  // fundamentally different risk than actual screen pixel capture, which
  // can contain literally anything on the user's screen (passwords in a
  // password manager window, private messages, financial data).
  "computer.eyes.read", // structural/semantic visual awareness — LOW
  "computer.eyes.capture", // on-demand pixel frame capture — HIGH
  // Persisting something Jarvis should remember past the current
  // conversation (a stated preference, a correction, a project fact).
  // MEDIUM via the standard ".write" suffix rule below — more
  // consequential than a pure read, but reversible through the existing
  // memory list/delete API, so it doesn't need approval.
  "memory.write",
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
  // computer.control covers launching/closing/focusing an app and
  // opening a file/folder — the spec's own LOW-risk tier, despite not
  // being literally read-only I/O, so it's scored at the "read" level
  // (see the PERMISSIONS comment above for the full rationale).
  if (permission === "computer.control") return "read";
  // Screen pixel capture can contain literally anything visible on the
  // monitor — scored the same as a delete (HIGH), not the plain LOW
  // "read" default a structural/semantic query gets.
  if (permission === "computer.eyes.capture") return "delete";
  if (permission.endsWith(".write")) return "write";
  if (permission.endsWith(".delete")) return "delete";
  if (permission.endsWith(".send")) return "send";
  if (permission === "phone.call") return "call";
  if (permission === "browser.interact" || permission === "computer.input") return "execute";
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
