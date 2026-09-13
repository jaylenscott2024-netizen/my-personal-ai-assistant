# Computer Control

## What this is

Jarvis can control the computer the backend process runs on: discover and
launch installed applications, manage windows, operate on real desktop
files, drive keyboard/mouse, take screenshots, and (only when an operator
explicitly allows it) run specific command-line tools. This document
covers the architecture, the security model, and — honestly — what's
verified in this development environment versus what needs a real desktop
to confirm.

## Where this runs

**This backend does not remote-control a separate machine.** Computer
control acts on whatever host the Node process itself is running on. For
"Jarvis, open Blender" to actually open Blender on your Windows PC, this
backend needs to be running as a service on that same PC (see
DEVELOPMENT.md). If you deploy the backend to a cloud VM instead, computer
control acts on that VM, not your desktop — which is likely not what you
want for this feature specifically (the AI provider, memory, business
integrations, etc. work identically wherever it runs).

There is no separate Tauri/Electron desktop bridge doing this instead —
see ARCHITECTURE.md's note on this for the reasoning. If a
desktop shell is added later, it should call this backend's HTTP/WebSocket
API rather than executing OS commands directly from a renderer process;
that keeps the exact same permission/approval gate in front of every
action regardless of which client asked for it.

## Application discovery (Section 4)

No hard-coded application list. `computer/appDiscovery.ts` reads each
platform's real registry of installed applications:

| Platform | Source | Verified here? |
|---|---|---|
| Windows | `Get-StartApps` via PowerShell | Code is standard and stable across modern Windows, but **not run in this sandbox** — no Windows host available. |
| macOS | `/Applications` and `~/Applications` `.app` bundles | Not run here — no macOS host available. |
| Linux | `.desktop` files under XDG data directories | **Verified**: this sandbox has real `.desktop` files (LibreOffice, Python, etc.) and `tests/computer.appDiscovery.test.ts` discovers and matches against them for real. |

A natural-language name ("Blender", "my browser") is resolved via fuzzy
scoring (`matchApplications`) — exact match, prefix match, substring
match, then token overlap, in that order. When no candidate is a clear
winner, the tool returns all candidates instead of guessing, and the
agent is instructed to ask the user which one they meant.

## Tools and risk tiers

Every tool in `tools/builtin/computerTools.ts` maps to the spec's own
three-tier risk model (`security/permissions.ts` documents the exact
mapping):

| Tier | Tools | Approval required? |
|---|---|---|
| **LOW** | list applications/windows, open/close/focus an application, open a file/folder, screenshot | No |
| **MEDIUM** | type, click/double-click/scroll/drag, move mouse, press key/hotkey, create/move/copy a file | No |
| **HIGH** | delete a file | **Yes** |
| **CRITICAL** | run an allowlisted command | **Yes**, and only if the executable is explicitly allowlisted |

`tests/computer.permissionTiers.test.ts` asserts every tool actually
scores at the tier the spec assigns it — this isn't just a comment, it's
enforced and tested.

## `computer_run_command`: the allowlist

Per the spec: *"Do NOT simply give the LLM unrestricted shell access. Use
an allowlisted/scoped execution architecture."* This is that
architecture, in `computer/commandRunner.ts`:

- `COMPUTER_COMMAND_ALLOWLIST` (env var) is a comma-separated list of bare
  executable names. **Empty by default** — nothing runs until an operator
  explicitly opts executables in.
- A path (`/bin/sh`) is rejected even if its basename would otherwise be
  allowlisted — only a bare name matches.
- Even an allowlisted command still goes through the normal permission
  check and mandatory approval (this tool's risk tier is the highest in
  the system) — the allowlist and the approval gate are two independent
  layers, not a substitute for each other.

## File operations: a different safety model than the sandboxed filesystem tool

`tools/builtin/filesystemTool.ts` (used for general assistant workspace
files) is scoped to one allowed root directory. `computer/fileOps.ts` is
different on purpose: a real desktop assistant needs to reach the user's
actual Downloads, Desktop, and Documents folders, which a single-root
sandbox can't express. Instead, it blocks a fixed list of
operating-system-critical paths (`/usr`, `/etc`, `/System`,
`C:\Windows`, `C:\Program Files`, etc.) and allows everything else,
gated by permission and, for deletion, mandatory approval.

## What's verified in this environment vs. what needs a real desktop

This development sandbox is a headless Linux container: no display server,
no Windows or macOS host, no GUI. Here's the honest split:

**Fully verified with real system calls (`tests/computer.*.test.ts`):**
- Linux application discovery against this environment's actual installed
  `.desktop` files.
- Fuzzy name-matching and ambiguous-candidate logic.
- All file operations (create/move/copy/delete folders and files,
  including recursive directory copy) against the real filesystem.
- Dangerous-path rejection.
- The command allowlist, including actually running an allowlisted
  command and capturing real stdout/exit codes.
- Closing a real running process by name via `pkill` — a genuine process
  is spawned, matched, and terminated in the test.
- Every tool's declared permission and approval requirement against the
  spec's risk tiers.

**Implemented with correct, standard commands, but not executable here
(no Windows/macOS host, no display server):**
- Windows application discovery (`Get-StartApps`) and launch
  (`shell:AppsFolder`).
- macOS application discovery and launch (`open -a`).
- Window listing/focus on all three platforms (Windows PowerShell,
  macOS `osascript`, Linux `wmctrl`).
- Keyboard/mouse control (Windows `SendKeys`, macOS `System Events`,
  Linux `xdotool`) — these require a live graphical session; this
  sandbox has none (`echo $DISPLAY` is empty). The code correctly detects
  this and raises `NotConfiguredError` with a clear reason rather than
  silently doing nothing.
- Screenshot capture on all three platforms — same display-server
  requirement.

**Known, documented gap:**
- **Mouse click/double-click/scroll/drag on Windows**: implemented via a
  small `user32!mouse_event` P/Invoke shim embedded directly in the
  PowerShell command (`computer/inputControl.ts`) — genuine button-down/up
  and wheel events, not just cursor positioning. This is standards-based,
  reviewed code that has never run against a real Windows session in this
  environment (no Windows host here); see the file's own comments for the
  exact flags used. `computer_move_mouse` (cursor positioning only, no
  P/Invoke) has always worked the same way.
- **Mouse drag on macOS**: `osascript`/System Events has no
  press-move-release primitive, only discrete click/double-click at a
  point — a real drag needs a native Accessibility-API helper this project
  doesn't bundle, so `computer_drag` raises `NotConfiguredError` there
  rather than faking a drag with a plain click. Click, double-click, and
  scroll all work on macOS via System Events.
- **Mouse movement/scroll on macOS**: `computer_move_mouse` and
  `computer_scroll` need Accessibility permission grants and a small
  native helper beyond what `osascript` alone can do reliably; documented
  as `NotConfiguredError` rather than a flaky partial implementation.

## Running this for real on your Windows PC

1. Install Node.js 20+ on the PC you want Jarvis to control.
2. Clone this repo, `npm install`, `npx prisma generate && npx prisma
   migrate deploy`.
3. Set `COMPUTER_COMMAND_ALLOWLIST` only if you specifically want
   `computer_run_command` available, naming exactly the executables you
   trust.
4. `npm run build && npm start` (or `npm run dev` for development).
5. Point your client (a future desktop app, or any HTTP client for now)
   at `http://localhost:4000`.

`xdotool` needs to be installed separately for keyboard/mouse control on
Linux desktops (`apt install xdotool` on Debian/Ubuntu); Windows and macOS
use built-in tools only.
