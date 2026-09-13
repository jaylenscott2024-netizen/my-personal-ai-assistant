import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { eyesService } from "../../eyes/eyesService.js";
import { NotConfiguredError } from "../../utils/errors.js";

function jsonSchema<T extends z.ZodTypeAny>(schema: T, name: string) {
  return zodToJsonSchema(schema, name) as Record<string, unknown>;
}

async function requireRunningEngine(userId: string) {
  const engine = await eyesService.getEngineIfRunning(userId);
  if (!engine) {
    throw new NotConfiguredError("Jarvis Eyes / Windows UI Automation (not currently running — enable Jarvis Eyes in Settings first)");
  }
  return engine;
}

// Section 27: Windows UI Automation tools. This is the "prefer semantic
// interaction over coordinate-guessing" half of computer control — a
// button is addressed by its automation id/name/control type and an
// opaque elementRef, never by (x, y). It rides the same VisualPerceptionEngine
// (and therefore the same eyesEnabled setting/platform capability) as the
// Eyes subsystem because both are sourced from the same Windows UI
// Automation surface, but conceptually these are structured/semantic
// queries, not visual perception — see EYES.md for the distinction.

const getUiTreeInput = z.object({
  windowId: z.string().optional().describe("Specific window id to root the tree at (from computer_list_windows); omit for the foreground window."),
  maxDepth: z.number().int().positive().max(20).optional().describe("Maximum tree depth to walk (default 5)."),
});
export const computerGetUiTreeTool: ToolDefinition<z.infer<typeof getUiTreeInput>> = {
  name: "computer_get_ui_tree",
  description: "Get the structured UI Automation tree (buttons, text fields, menus, tabs, lists, etc.) for a window — semantic control info (name, automation id, control type, enabled/focused state, patterns), not pixels.",
  version: "1.0.0",
  inputSchema: getUiTreeInput,
  jsonSchema: jsonSchema(getUiTreeInput, "computer_get_ui_tree"),
  requiredPermissions: ["computer.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    return { output: await engine.getUiTree(input.windowId, input.maxDepth) };
  },
};

const findUiElementInput = z.object({
  windowId: z.string().optional().describe("Window id to search within (from computer_list_windows); omit for the foreground window."),
  name: z.string().optional().describe("Exact accessible name to match, e.g. 'Save'."),
  automationId: z.string().optional().describe("Exact automation id to match, e.g. 'btnSave'."),
  controlType: z.string().optional().describe("UI Automation control type to match, e.g. 'Button', 'Edit', 'MenuItem'."),
});
export const computerFindUiElementTool: ToolDefinition<z.infer<typeof findUiElementInput>> = {
  name: "computer_find_ui_element",
  description: "Find UI Automation elements matching a name, automation id, and/or control type — the preferred way to locate a specific control before invoking it, instead of guessing screen coordinates.",
  version: "1.0.0",
  inputSchema: findUiElementInput,
  jsonSchema: jsonSchema(findUiElementInput, "computer_find_ui_element"),
  requiredPermissions: ["computer.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    const elements = await engine.findUiElement(input);
    return { output: { elements } };
  },
};

const elementRefInput = z.object({
  elementRef: z.string().describe("Opaque element reference returned by computer_get_ui_tree or computer_find_ui_element."),
});
export const computerGetUiElementTool: ToolDefinition<z.infer<typeof elementRefInput>> = {
  name: "computer_get_ui_element",
  description: "Re-resolve a specific UI element by its opaque reference and report its CURRENT state (enabled/focused/value can change between when it was found and now) without re-walking the whole tree it came from.",
  version: "1.0.0",
  inputSchema: elementRefInput,
  jsonSchema: jsonSchema(elementRefInput, "computer_get_ui_element"),
  requiredPermissions: ["computer.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    return { output: await engine.getUiElement(input.elementRef) };
  },
};

export const computerInvokeUiElementTool: ToolDefinition<z.infer<typeof elementRefInput>> = {
  name: "computer_invoke_ui_element",
  description: "Invoke a UI element (click a button, toggle a checkbox, select a list item) via its UI Automation pattern (Invoke/Toggle/SelectionItem) — the preferred, semantic alternative to a coordinate-based click.",
  version: "1.0.0",
  inputSchema: elementRefInput,
  jsonSchema: jsonSchema(elementRefInput, "computer_invoke_ui_element"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    await engine.invokeUiElement(input.elementRef);
    return { output: { invoked: true } };
  },
};

const setUiValueInput = z.object({
  elementRef: z.string().describe("Opaque element reference returned by computer_get_ui_tree or computer_find_ui_element."),
  value: z.string(),
});
export const computerSetUiValueTool: ToolDefinition<z.infer<typeof setUiValueInput>> = {
  name: "computer_set_ui_value",
  description: "Set the value of a text field or other Value-pattern UI element directly via UI Automation — the preferred, semantic alternative to focusing a field and typing coordinates-first.",
  version: "1.0.0",
  inputSchema: setUiValueInput,
  jsonSchema: jsonSchema(setUiValueInput, "computer_set_ui_value"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    await engine.setUiElementValue(input.elementRef, input.value);
    return { output: { set: true } };
  },
};

export const computerFocusUiElementTool: ToolDefinition<z.infer<typeof elementRefInput>> = {
  name: "computer_focus_ui_element",
  description: "Move keyboard focus to a specific UI element via UI Automation — the preferred, semantic alternative to clicking a coordinate to focus it.",
  version: "1.0.0",
  inputSchema: elementRefInput,
  jsonSchema: jsonSchema(elementRefInput, "computer_focus_ui_element"),
  requiredPermissions: ["computer.input"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    await engine.focusUiElement(input.elementRef);
    return { output: { focused: true } };
  },
};

export const uiAutomationTools: ToolDefinition[] = [
  computerGetUiTreeTool as ToolDefinition,
  computerFindUiElementTool as ToolDefinition,
  computerGetUiElementTool as ToolDefinition,
  computerInvokeUiElementTool as ToolDefinition,
  computerSetUiValueTool as ToolDefinition,
  computerFocusUiElementTool as ToolDefinition,
];
