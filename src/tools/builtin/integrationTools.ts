import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { githubIntegration } from "../../integrations/github.js";
import { shopifyIntegration } from "../../integrations/shopify.js";
import { emailIntegration } from "../../integrations/email.js";
import { googleCalendarIntegration } from "../../integrations/googleCalendar.js";
import { twilioIntegration } from "../../integrations/twilio.js";

function jsonSchema<T extends z.ZodTypeAny>(schema: T, name: string) {
  return zodToJsonSchema(schema, name) as Record<string, unknown>;
}

const githubSearchInput = z.object({ query: z.string() });
export const githubSearchCodeTool: ToolDefinition<z.infer<typeof githubSearchInput>> = {
  name: "github_search_code",
  description: "Search code across GitHub repositories the configured token can access.",
  version: "1.0.0",
  inputSchema: githubSearchInput,
  jsonSchema: jsonSchema(githubSearchInput, "github_search_code"),
  requiredPermissions: ["github.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await githubIntegration.searchCode(input.query), untrusted: true };
  },
};

const githubCreateIssueInput = z.object({ owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional() });
export const githubCreateIssueTool: ToolDefinition<z.infer<typeof githubCreateIssueInput>> = {
  name: "github_create_issue",
  description: "Create a GitHub issue in a repository.",
  version: "1.0.0",
  inputSchema: githubCreateIssueInput,
  jsonSchema: jsonSchema(githubCreateIssueInput, "github_create_issue"),
  requiredPermissions: ["github.write"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await githubIntegration.createIssue(input.owner, input.repo, input.title, input.body) };
  },
};

const shopifyReadInput = z.object({ resource: z.enum(["shop", "orders", "products"]), limit: z.number().int().positive().max(100).default(20) });
export const shopifyReadTool: ToolDefinition<z.infer<typeof shopifyReadInput>> = {
  name: "shopify_read",
  description: "Read Shopify store data: shop info, recent orders, or products.",
  version: "1.0.0",
  inputSchema: shopifyReadInput,
  jsonSchema: jsonSchema(shopifyReadInput, "shopify_read"),
  requiredPermissions: ["shopify.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    if (input.resource === "shop") return { output: await shopifyIntegration.getShopInfo() };
    if (input.resource === "orders") return { output: await shopifyIntegration.listOrders(input.limit) };
    return { output: await shopifyIntegration.listProducts(input.limit) };
  },
};

const shopifyWriteInput = z.object({ productId: z.string(), updates: z.record(z.unknown()) });
export const shopifyUpdateProductTool: ToolDefinition<z.infer<typeof shopifyWriteInput>> = {
  name: "shopify_update_product",
  description: "Update a Shopify product (e.g. price, title, status).",
  version: "1.0.0",
  inputSchema: shopifyWriteInput,
  jsonSchema: jsonSchema(shopifyWriteInput, "shopify_update_product"),
  requiredPermissions: ["shopify.write"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await shopifyIntegration.updateProduct(input.productId, input.updates) };
  },
};

const emailSendInput = z.object({ to: z.string().email(), subject: z.string(), body: z.string() });
export const emailSendTool: ToolDefinition<z.infer<typeof emailSendInput>> = {
  name: "email_send",
  description: "Send an email through the configured SMTP account.",
  version: "1.0.0",
  inputSchema: emailSendInput,
  jsonSchema: jsonSchema(emailSendInput, "email_send"),
  requiredPermissions: ["email.send"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await emailIntegration.send(input.to, input.subject, input.body) };
  },
};

const calendarListInput = z.object({ timeMinIso: z.string(), timeMaxIso: z.string() });
export const calendarListEventsTool: ToolDefinition<z.infer<typeof calendarListInput>> = {
  name: "calendar_list_events",
  description: "List Google Calendar events in a time range.",
  version: "1.0.0",
  inputSchema: calendarListInput,
  jsonSchema: jsonSchema(calendarListInput, "calendar_list_events"),
  requiredPermissions: ["calendar.read"],
  requiresApproval: false,
  source: "builtin",
  async execute(input) {
    return { output: await googleCalendarIntegration.listEvents(input.timeMinIso, input.timeMaxIso), untrusted: true };
  },
};

const calendarCreateInput = z.object({
  summary: z.string(),
  description: z.string().optional(),
  startIso: z.string(),
  endIso: z.string(),
  timezone: z.string().optional(),
});
export const calendarCreateEventTool: ToolDefinition<z.infer<typeof calendarCreateInput>> = {
  name: "calendar_create_event",
  description: "Create a Google Calendar event.",
  version: "1.0.0",
  inputSchema: calendarCreateInput,
  jsonSchema: jsonSchema(calendarCreateInput, "calendar_create_event"),
  requiredPermissions: ["calendar.write"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await googleCalendarIntegration.createEvent(input) };
  },
};

const phoneCallInput = z.object({ to: z.string(), twimlUrl: z.string().url() });
export const phoneCallTool: ToolDefinition<z.infer<typeof phoneCallInput>> = {
  name: "phone_call",
  description: "Place an outbound phone call via Twilio, driven by TwiML at the given URL.",
  version: "1.0.0",
  inputSchema: phoneCallInput,
  jsonSchema: jsonSchema(phoneCallInput, "phone_call"),
  requiredPermissions: ["phone.call"],
  requiresApproval: true,
  source: "builtin",
  async execute(input) {
    return { output: await twilioIntegration.placeCall(input.to, input.twimlUrl) };
  },
};

export const integrationTools: ToolDefinition[] = [
  githubSearchCodeTool as ToolDefinition,
  githubCreateIssueTool as ToolDefinition,
  shopifyReadTool as ToolDefinition,
  shopifyUpdateProductTool as ToolDefinition,
  emailSendTool as ToolDefinition,
  calendarListEventsTool as ToolDefinition,
  calendarCreateEventTool as ToolDefinition,
  phoneCallTool as ToolDefinition,
];
