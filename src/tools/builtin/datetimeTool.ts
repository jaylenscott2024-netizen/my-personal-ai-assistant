import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";

const inputSchema = z.object({
  timezone: z.string().optional().describe("IANA timezone, e.g. 'America/New_York'. Defaults to UTC."),
});

export const datetimeTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "current_datetime",
  description: "Get the current date and time, optionally in a specific IANA timezone.",
  version: "1.0.0",
  inputSchema,
  jsonSchema: zodToJsonSchema(inputSchema, "current_datetime") as Record<string, unknown>,
  requiredPermissions: [],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: input.timezone ?? "UTC",
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
    return { output: { iso: now.toISOString(), formatted, timezone: input.timezone ?? "UTC" } };
  },
};
