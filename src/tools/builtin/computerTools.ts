import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { discoverApplications, matchApplications } from "../../computer/appDiscovery.js";
import { openApplication, closeApplication } from "../../computer/appLauncher.js";
import { listWindows, focusWindow } from "../../computer/windowControl.js";
import { openFile, openFolder, createFolder, moveFile, copyFile, deleteFile } from "../../computer/fileOps.js";
import { typeText, pressKey, hotkey, click, doubleClick, scroll, drag, moveMouse } from "../../computer/inputControl.js";
import { captureScreenshot } from "../../computer/screenshot.js";
import { runAllowlistedCommand } from "../../computer/commandRunner.js";
import { currentPlatform } from "../../computer/platform.js";

function jsonSchema<T extends z.ZodTypeAny>(schema: T, name: string) {
  return zodToJsonSchema(schema, name) as Record<string, unknown>;
}

// Section 3/4/8 of the Jarvis spec: generalized, discovery-backed computer
// control tools — never a hard-coded list of applications. Risk tiers
// (and therefore which need approval) exactly follow the spec's own
// LOW/MEDIUM/HIGH categorization; see security/permissions.ts for the
// full rationale of how each permission scores.

const listApplicationsInput = z.object({});
export const computerListApplicationsTool: ToolDefinition<z.infer<typeof listApplicationsInput>> = {
  name: "computer_list_applications",
  description: "List applications installed on this computer, discovered from the OS's own application registry.",
  version: "1.0.0",
  inputSchema: listApplicationsInput,
  jsonSchema: jsonSchema(listApplicationsInput, "computer_list_applications"),
  requiredPermissions: ["computer.read"],
  requiresApproval: false,
  source: "builtin",
  async execute() {
    const apps = await discoverApplications();
    return { output: { platform: currentPlatform(), count: apps.length, applications: apps.map((a) => ({ name: a.name, id: a.id })) } };
  },
};

const openApplicationInput = z.object({ name: z.string().describe("Natural-language application name, e.g. 'Blender' or 'Chrome'.") });
export const computerOpenApplicationTool: ToolDefinition<z.infer<typeof openApplicationInput>> = {
  name: "computer_open_application",
  description:
    "Open/launch an installed application by name. If more than one installed application could match, returns candidates instead of guessing — ask the user which one they mean.",
  version: "1.0.0",
  inputSchema: openApplicationInput,
  jsonSchema: jsonSchema(openApplicationInput, "computer_open_application"),
  requiredPermissions: ["computer.control"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    const result = await openApplication(input.name);
    if ("ambiguous" in result) {
      return { output: { ambiguous: true, candidates: result.candidates, message: "Multiple applications match — ask the user which one they meant." } };
    }
    return { output: { launched: true, application: result.app.name } };
  },
};

const closeApplicationInput = z.object({ name: z.string().describe("Application or process name to close.") });
export const computerCloseApplicationTool: ToolDefinition<z.infer<typeof closeApplicationInput>> = {
  name: "computer_close_application",
  description: "Close a running application by name.",
  version: "1.0.0",
  inputSchema: closeApplicationInput,
  jsonSchema: jsonSchema(closeApplicationInput, "computer_close_application"),
  requiredPermissions: ["computer.control"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await closeApplication(input.name) };
  },
};

const focusWindowInput = z.object({ title: z.string().describe("Window title or process name to bring to the foreground.") });
export const computerFocusWindowTool: ToolDefinition<z.infer<typeof focusWindowInput>> = {
  name: "computer_focus_window",
  description: "Bring a window to the foreground by title or process name.",
  version: "1.0.0",
  inputSchema: focusWindowInput,
  jsonSchema: jsonSchema(focusWindowInput, "computer_focus_window"),
  requiredPermissions: ["computer.control"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await focusWindow(input.title) };
  },
};

const listWindowsInput = z.object({});
export const computerListWindowsTool: ToolDefinition<z.infer<typeof listWindowsInput>> = {
  name: "computer_list_windows",
  description: "List currently open windows and their titles.",
  version: "1.0.0",
  inputSchema: listWindowsInput,
  jsonSchema: jsonSchema(listWindowsInput, "computer_list_windows"),
  requiredPermissions: ["computer.read"],
  requiresApproval: false,
  source: "builtin",
  async execute() {
    return { output: { windows: await listWindows() } };
  },
};

const pathInput = z.object({ path: z.string().describe("Absolute path, or '~' for the home directory.") });
export const computerOpenFileTool: ToolDefinition<z.infer<typeof pathInput>> = {
  name: "computer_open_file",
  description: "Open a file with its default application (e.g. open a PDF in the default PDF viewer).",
  version: "1.0.0",
  inputSchema: pathInput,
  jsonSchema: jsonSchema(pathInput, "computer_open_file"),
  requiredPermissions: ["computer.control"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await openFile(input.path) };
  },
};

export const computerOpenFolderTool: ToolDefinition<z.infer<typeof pathInput>> = {
  name: "computer_open_folder",
  description: "Open a folder in the system file manager (e.g. Windows Explorer, Finder, Nautilus).",
  version: "1.0.0",
  inputSchema: pathInput,
  jsonSchema: jsonSchema(pathInput, "computer_open_folder"),
  requiredPermissions: ["computer.control"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await openFolder(input.path) };
  },
};

export const computerCreateFolderTool: ToolDefinition<z.infer<typeof pathInput>> = {
  name: "computer_create_folder",
  description: "Create a folder (and any missing parent folders) at the given path.",
  version: "1.0.0",
  inputSchema: pathInput,
  jsonSchema: jsonSchema(pathInput, "computer_create_folder"),
  requiredPermissions: ["computer.files.write"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await createFolder(input.path) };
  },
};

const moveCopyInput = z.object({ from: z.string(), to: z.string() });
export const computerMoveFileTool: ToolDefinition<z.infer<typeof moveCopyInput>> = {
  name: "computer_move_file",
  description: "Move (or rename) a file or folder from one path to another.",
  version: "1.0.0",
  inputSchema: moveCopyInput,
  jsonSchema: jsonSchema(moveCopyInput, "computer_move_file"),
  requiredPermissions: ["computer.files.write"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await moveFile(input.from, input.to) };
  },
};

export const computerCopyFileTool: ToolDefinition<z.infer<typeof moveCopyInput>> = {
  name: "computer_copy_file",
  description: "Copy a file or folder from one path to another.",
  version: "1.0.0",
  inputSchema: moveCopyInput,
  jsonSchema: jsonSchema(moveCopyInput, "computer_copy_file"),
  requiredPermissions: ["computer.files.write"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await copyFile(input.from, input.to) };
  },
};

export const computerDeleteFileTool: ToolDefinition<z.infer<typeof pathInput>> = {
  name: "computer_delete_file",
  description: "Permanently delete a file or folder. High-risk — requires user approval.",
  version: "1.0.0",
  inputSchema: pathInput,
  jsonSchema: jsonSchema(pathInput, "computer_delete_file"),
  requiredPermissions: ["computer.files.delete"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await deleteFile(input.path) };
  },
};

const typeInput = z.object({ text: z.string() });
export const computerTypeTool: ToolDefinition<z.infer<typeof typeInput>> = {
  name: "computer_type",
  description: "Type text into whatever window/field currently has focus.",
  version: "1.0.0",
  inputSchema: typeInput,
  jsonSchema: jsonSchema(typeInput, "computer_type"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await typeText(input.text) };
  },
};

const pressKeyInput = z.object({ key: z.string().describe("Key name, e.g. 'Return', 'Escape', 'Tab'.") });
export const computerPressKeyTool: ToolDefinition<z.infer<typeof pressKeyInput>> = {
  name: "computer_press_key",
  description: "Press a single key (e.g. Enter, Escape, Tab).",
  version: "1.0.0",
  inputSchema: pressKeyInput,
  jsonSchema: jsonSchema(pressKeyInput, "computer_press_key"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await pressKey(input.key) };
  },
};

const hotkeyInput = z.object({ keys: z.array(z.string()).min(1).describe("e.g. ['ctrl', 'c'] for copy.") });
export const computerHotkeyTool: ToolDefinition<z.infer<typeof hotkeyInput>> = {
  name: "computer_hotkey",
  description: "Press a key combination, e.g. ['ctrl', 'c'] for copy.",
  version: "1.0.0",
  inputSchema: hotkeyInput,
  jsonSchema: jsonSchema(hotkeyInput, "computer_hotkey"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await hotkey(input.keys) };
  },
};

const clickInput = z.object({ x: z.number().int(), y: z.number().int(), button: z.enum(["left", "right"]).default("left") });
export const computerClickTool: ToolDefinition<z.infer<typeof clickInput>> = {
  name: "computer_click",
  description: "Click at a specific screen coordinate.",
  version: "1.0.0",
  inputSchema: clickInput,
  jsonSchema: jsonSchema(clickInput, "computer_click"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await click(input.x, input.y, input.button) };
  },
};

const doubleClickInput = z.object({ x: z.number().int(), y: z.number().int() });
export const computerDoubleClickTool: ToolDefinition<z.infer<typeof doubleClickInput>> = {
  name: "computer_double_click",
  description: "Double-click at a specific screen coordinate.",
  version: "1.0.0",
  inputSchema: doubleClickInput,
  jsonSchema: jsonSchema(doubleClickInput, "computer_double_click"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await doubleClick(input.x, input.y) };
  },
};

const scrollInput = z.object({
  x: z.number().int(),
  y: z.number().int(),
  amount: z.number().describe("Positive scrolls up/away from the user, negative scrolls down — one wheel step is approximately 1.0."),
});
export const computerScrollTool: ToolDefinition<z.infer<typeof scrollInput>> = {
  name: "computer_scroll",
  description: "Scroll the mouse wheel at a specific screen coordinate.",
  version: "1.0.0",
  inputSchema: scrollInput,
  jsonSchema: jsonSchema(scrollInput, "computer_scroll"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await scroll(input.x, input.y, input.amount) };
  },
};

const dragInput = z.object({ fromX: z.number().int(), fromY: z.number().int(), toX: z.number().int(), toY: z.number().int() });
export const computerDragTool: ToolDefinition<z.infer<typeof dragInput>> = {
  name: "computer_drag",
  description: "Press the left mouse button at one coordinate, move to another, and release — for drag-and-drop, selection, or sliders.",
  version: "1.0.0",
  inputSchema: dragInput,
  jsonSchema: jsonSchema(dragInput, "computer_drag"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await drag(input.fromX, input.fromY, input.toX, input.toY) };
  },
};

const moveMouseInput = z.object({ x: z.number().int(), y: z.number().int() });
export const computerMoveMouseTool: ToolDefinition<z.infer<typeof moveMouseInput>> = {
  name: "computer_move_mouse",
  description: "Move the mouse cursor to a specific screen coordinate.",
  version: "1.0.0",
  inputSchema: moveMouseInput,
  jsonSchema: jsonSchema(moveMouseInput, "computer_move_mouse"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await moveMouse(input.x, input.y) };
  },
};

const screenshotInput = z.object({});
export const computerScreenshotTool: ToolDefinition<z.infer<typeof screenshotInput>> = {
  name: "computer_screenshot",
  description: "Capture a screenshot of the current screen.",
  version: "1.0.0",
  inputSchema: screenshotInput,
  jsonSchema: jsonSchema(screenshotInput, "computer_screenshot"),
  requiredPermissions: ["computer.read"],
  requiresApproval: false,
  source: "builtin",
  async execute() {
    return { output: await captureScreenshot() };
  },
};

const waitInput = z.object({ ms: z.number().int().positive().max(30_000).describe("Milliseconds to wait, max 30000.") });
export const computerWaitTool: ToolDefinition<z.infer<typeof waitInput>> = {
  name: "computer_wait",
  description: "Wait for a short period before continuing (e.g. to let an application finish opening).",
  version: "1.0.0",
  inputSchema: waitInput,
  jsonSchema: jsonSchema(waitInput, "computer_wait"),
  requiredPermissions: [],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    await new Promise((resolve) => setTimeout(resolve, input.ms));
    return { output: { waitedMs: input.ms } };
  },
};

const runCommandInput = z.object({
  executable: z.string().describe("Bare executable name, no path — must be operator-allowlisted."),
  args: z.array(z.string()).default([]),
});
export const computerRunCommandTool: ToolDefinition<z.infer<typeof runCommandInput>> = {
  name: "computer_run_command",
  description:
    "Run an allowlisted command-line executable. Only executables an operator has explicitly allowed (COMPUTER_COMMAND_ALLOWLIST) can run — everything else is refused. Always requires approval.",
  version: "1.0.0",
  inputSchema: runCommandInput,
  jsonSchema: jsonSchema(runCommandInput, "computer_run_command"),
  requiredPermissions: ["computer.execute"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await runAllowlistedCommand(input.executable, input.args) };
  },
};

export const computerTools: ToolDefinition[] = [
  computerListApplicationsTool as ToolDefinition,
  computerOpenApplicationTool as ToolDefinition,
  computerCloseApplicationTool as ToolDefinition,
  computerFocusWindowTool as ToolDefinition,
  computerListWindowsTool as ToolDefinition,
  computerOpenFileTool as ToolDefinition,
  computerOpenFolderTool as ToolDefinition,
  computerCreateFolderTool as ToolDefinition,
  computerMoveFileTool as ToolDefinition,
  computerCopyFileTool as ToolDefinition,
  computerDeleteFileTool as ToolDefinition,
  computerTypeTool as ToolDefinition,
  computerPressKeyTool as ToolDefinition,
  computerHotkeyTool as ToolDefinition,
  computerClickTool as ToolDefinition,
  computerDoubleClickTool as ToolDefinition,
  computerScrollTool as ToolDefinition,
  computerDragTool as ToolDefinition,
  computerMoveMouseTool as ToolDefinition,
  computerScreenshotTool as ToolDefinition,
  computerWaitTool as ToolDefinition,
  computerRunCommandTool as ToolDefinition,
];

// Exported for reuse by an agentic "resolve this app name" step elsewhere
// if ever needed outside the tool call itself.
export { matchApplications };
