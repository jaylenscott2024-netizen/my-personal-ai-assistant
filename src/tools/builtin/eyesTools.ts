import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { eyesService } from "../../eyes/eyesService.js";
import { NotConfiguredError } from "../../utils/errors.js";
import type { VisualContext, VisualContextDetail, VisualContextPurpose } from "../../eyes/visualContext.js";
import type { VisualPerceptionEngine } from "../../eyes/visualPerceptionEngine.js";

function jsonSchema<T extends z.ZodTypeAny>(schema: T, name: string) {
  return zodToJsonSchema(schema, name) as Record<string, unknown>;
}

async function requireRunningEngine(userId: string): Promise<VisualPerceptionEngine> {
  const engine = await eyesService.getEngineIfRunning(userId);
  if (!engine) {
    throw new NotConfiguredError("Jarvis Eyes (not currently running — enable it in Settings first)");
  }
  return engine;
}

/** Returns a copy with every pixel removed. Used whenever the caller did
 *  NOT hold computer.eyes.capture for this call: the model still gets the
 *  full structural timeline, just no imagery. Copies rather than mutating,
 *  because these samples are shared with the engine's live history. */
function stripFrames(context: VisualContext): VisualContext {
  return {
    ...context,
    currentSample: context.currentSample ? { ...context.currentSample, frame: null } : null,
    samples: context.samples.map((sample) => (sample.frame ? { ...sample, frame: null } : sample)),
  };
}

/** Adds one freshly captured frame to the newest observation, on demand.
 *  This is the only capture path a model can trigger, and it is a single
 *  frame per call — never a stream, never a loop. */
async function withFreshFrame(engine: VisualPerceptionEngine, context: VisualContext): Promise<VisualContext> {
  const frame = await engine.requestFrame();
  const samples = [...context.samples];
  const newest = samples.length > 0 ? samples[samples.length - 1] : context.currentSample;
  if (!newest) return context;

  const framed = { ...newest, frame };
  if (samples.length > 0) samples[samples.length - 1] = framed;
  else samples.push(framed);

  return { ...context, samples, currentSample: framed };
}

// Section 12/27: the model-facing surface of the Eyes engine. Note what
// these tools do NOT do: they never start a capture loop, never poll, and
// never decide how the visual context reaches the model. They answer a
// temporal question provider-neutrally; the orchestrator hands the result
// to whichever vision transport adapter fits the active model.

const getVisualStateInput = z.object({
  includeVisual: z
    .boolean()
    .default(false)
    .describe(
      "If true, also capture one fresh frame to attach. Requires the computer.eyes.capture permission and is subject to approval, the provider allowlist, and the active model's actual visual capabilities — never assume it was included.",
    ),
});

export const eyesGetVisualStateTool: ToolDefinition<z.infer<typeof getVisualStateInput>> = {
  name: "eyes_get_visual_state",
  description:
    "Get Jarvis's current visual awareness: the foreground window, open windows, and recent visual events (window/focus changes, UI Automation changes) — built from real-time OS events, never a screenshot polling loop. Optionally attach one freshly captured frame (includeVisual:true).",
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
      visualHistory: engine.getHistory().stats(),
    };

    const base = engine.buildContext({ purpose: "current_state", detail: input.includeVisual ? "medium" : "low" });
    const visualContext = input.includeVisual ? await withFreshFrame(engine, base) : stripFrames(base);

    return { output, visualContext };
  },
};

const PURPOSES: [VisualContextPurpose, ...VisualContextPurpose[]] = [
  "current_state",
  "what_changed",
  "what_just_happened",
  "inspect_region",
  "understand_scene",
  "follow_visual_activity",
];

const DETAILS: [VisualContextDetail, ...VisualContextDetail[]] = ["low", "medium", "high"];

const queryVisualHistoryInput = z.object({
  purpose: z
    .enum(PURPOSES)
    .default("what_just_happened")
    .describe(
      "What you're trying to learn. Drives how far back Jarvis looks and how many observations it returns: current_state (right now), what_changed / what_just_happened (a transition, with before/after), inspect_region, understand_scene, follow_visual_activity (a sweep of salient moments).",
    ),
  sinceSeconds: z
    .number()
    .int()
    .positive()
    .max(1800)
    .optional()
    .describe("How far back to look. Omit to use the default window for the chosen purpose."),
  detail: z.enum(DETAILS).default("medium").describe("How many observations to include."),
  minAttention: z.number().min(0).max(1).optional().describe("Ignore observations less salient than this (0-1)."),
  includeVisual: z
    .boolean()
    .default(false)
    .describe(
      "Include captured keyframes the engine already holds in its in-memory buffer. Requires computer.eyes.capture; without it you still get the full structural timeline, just no imagery.",
    ),
});

export const eyesQueryVisualHistoryTool: ToolDefinition<z.infer<typeof queryVisualHistoryInput>> = {
  name: "eyes_query_visual_history",
  description:
    "Ask what happened on screen over a recent window of time — 'what just changed?', 'what have I been working on?'. Answered from Jarvis's own bounded in-memory visual memory, which is recorded continuously as events occur, so no capture happens at query time. Nothing here is persisted to disk.",
  version: "1.0.0",
  inputSchema: queryVisualHistoryInput,
  jsonSchema: jsonSchema(queryVisualHistoryInput, "eyes_query_visual_history"),
  requiredPermissions: ["computer.eyes.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const engine = await requireRunningEngine(ctx.userId);
    const now = Date.now();
    const base = engine.buildContext(
      {
        purpose: input.purpose,
        detail: input.detail,
        attentionThreshold: input.minAttention,
        since: input.sinceSeconds ? now - input.sinceSeconds * 1000 : undefined,
      },
      now,
    );
    const visualContext = input.includeVisual ? base : stripFrames(base);

    return {
      output: {
        purpose: visualContext.purpose,
        windowMs: visualContext.windowMs,
        temporalSummary: visualContext.temporalSummary,
        attention: visualContext.attention,
        observations: visualContext.samples.map((sample) => ({
          atMs: sample.atMs,
          changeKind: sample.changeKind,
          attention: sample.attention,
          attentionScore: sample.attentionScore,
          summary: sample.summary,
          window: sample.source.windowTitle,
          process: sample.source.processName,
          hasImage: sample.frame !== null,
        })),
      },
      // Marked untrusted: window titles and on-screen text are external
      // content in exactly the way a fetched web page is.
      untrusted: true,
      visualContext,
    };
  },
};

export const eyesTools: ToolDefinition[] = [
  eyesGetVisualStateTool as ToolDefinition,
  eyesQueryVisualHistoryTool as ToolDefinition,
];
