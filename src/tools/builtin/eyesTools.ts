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
    throw new NotConfiguredError("Jarvis Eyes (not currently running — enable it in Settings first)");
  }
  return engine;
}

// Section 27: this is the model-facing surface of the Eyes Engine's
// ambient/peripheral awareness (the same VisualState the orchestrator's
// system prompt already summarizes via visualContextAdapter.ts) — a tool
// call lets the model pull it on demand mid-turn instead of only ever
// seeing the passive summary. It is always structural/text by default;
// includeVisual only ever adds a SINGLE on-demand captured frame, never a
// stream, and only when the caller actually holds computer.eyes.capture
// (see permissionResolution.ts, which raises the required permission set
// specifically when includeVisual is requested) — this tool itself never
// silently escalates or falls back to a screenshot loop.
const getVisualStateInput = z.object({
  includeVisual: z
    .boolean()
    .default(false)
    .describe(
      "If true, also attach one on-demand captured frame alongside the structural summary. Requires the computer.eyes.capture permission and is subject to approval and the active model's vision support — never assume it was actually included.",
    ),
});

export const eyesGetVisualStateTool: ToolDefinition<z.infer<typeof getVisualStateInput>> = {
  name: "eyes_get_visual_state",
  description:
    "Get Jarvis's current visual awareness: the foreground window, open windows, and recent visual events (window/focus changes, UI Automation structure/property changes) — built entirely from real-time OS events, never a screenshot polling loop. Optionally attach a single on-demand frame (includeVisual:true), gated by permission and by whether the active AI model actually supports vision.",
  version: "1.0.0",
  inputSchema: getVisualStateInput,
  jsonSchema: jsonSchema(getVisualStateInput, "eyes_get_visual_state"),
  requiredPermissions: ["computer.eyes.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    const state = engine.getState();
    const output = {
      initialized: state.initialized,
      foregroundWindow: state.foregroundWindow,
      windows: state.windows,
      primaryFocus: state.primaryFocus,
      recentEvents: state.recentEvents.slice(0, 20),
    };

    if (!input.includeVisual) {
      return { output };
    }

    const frame = await engine.requestFrame();
    return { output, images: [{ mimeType: frame.mimeType, base64: frame.base64 }] };
  },
};

export const eyesTools: ToolDefinition[] = [eyesGetVisualStateTool as ToolDefinition];
