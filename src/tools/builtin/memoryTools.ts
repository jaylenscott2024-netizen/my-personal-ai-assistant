import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { rememberFact } from "../../memory/memoryService.js";

function jsonSchema<T extends z.ZodTypeAny>(schema: T, name: string) {
  return zodToJsonSchema(schema, name) as Record<string, unknown>;
}

// The write side of the memory system's model-facing surface. Without
// this, "the user shouldn't have to repeat themselves" and "incorporate a
// correction" are things the system prompt can ask for but the model has
// no way to actually do — retrieveRelevantMemory (wired into every agent
// turn) can only surface what's already there. This tool is what lets
// something said in one conversation still be true in the next one.
const rememberInput = z.object({
  content: z.string().min(1).describe("The fact, preference, or correction to remember, written as a standalone statement (e.g. \"Prefers email over Slack for non-urgent updates\")."),
  category: z.enum(["preference", "project", "task", "fact", "instruction"]).describe("preference: how the user wants things done. project/task: working context. fact: something true about the user or their situation. instruction: a standing directive for how to behave."),
  // Optional, but the important field for correction-handling: giving the
  // same stable key for "the same slot of information" (e.g.
  // "contact_preference") means a later call with a corrected value
  // replaces the old one instead of leaving both to be retrieved
  // side-by-side and contradict each other.
  key: z.string().optional().describe("A stable identifier for this specific piece of information, if it has one — reuse the same key next time this same fact is updated or corrected, so the new value replaces the old rather than sitting alongside it."),
  importance: z.number().int().min(1).max(5).optional().describe("1 (minor) to 5 (critical) — defaults to 3. Higher importance is retrieved more readily in future conversations."),
  scope: z.string().optional().describe("An optional project/task scoping key, if this only applies within a specific context."),
});

export const memoryRememberTool: ToolDefinition<z.infer<typeof rememberInput>> = {
  name: "memory_remember",
  description:
    "Persist something the user told you so you don't have to ask again in a future conversation — a stated preference, a correction to something you got wrong, or a fact worth carrying forward. Use this when the user corrects you or tells you something clearly meant to stick, not for routine conversational content.",
  version: "1.0.0",
  inputSchema: rememberInput,
  jsonSchema: jsonSchema(rememberInput, "memory_remember"),
  requiredPermissions: ["memory.write"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const { item, replacedExisting } = await rememberFact({
      userId: ctx.userId,
      category: input.category,
      content: input.content,
      key: input.key,
      importance: input.importance,
      provenance: "user_stated",
      scope: input.scope,
    });
    return { output: { remembered: true, id: item.id, replacedExisting } };
  },
};

export const memoryTools: ToolDefinition[] = [memoryRememberTool as ToolDefinition];
