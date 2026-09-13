import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { request } from "undici";
import type { ToolDefinition } from "../types.js";
import { ValidationError } from "../../utils/errors.js";

const inputSchema = z.object({
  url: z.string().url().describe("The URL to fetch."),
  maxLength: z.number().int().positive().max(50_000).default(8000),
});

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Real HTTP fetch (Section 27: Web Research Engine building block). SSRF
// guardrails: block loopback/link-local targets since this tool is callable
// by the agent with only `network.fetch` permission, not full network
// access to internal infrastructure.
export const webFetchTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "web_fetch",
  description: "Fetch a public web page and return its visible text content. Use for research and reading sources.",
  version: "1.0.0",
  inputSchema,
  jsonSchema: zodToJsonSchema(inputSchema, "web_fetch") as Record<string, unknown>,
  requiredPermissions: ["network.fetch"],
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new ValidationError("Only http/https URLs are allowed.");
    }
    if (BLOCKED_HOSTS.has(url.hostname) || url.hostname.endsWith(".local")) {
      throw new ValidationError("Fetching internal/loopback addresses is not allowed.");
    }

    const res = await request(url, {
      method: "GET",
      headers: { "user-agent": "VolticLaneAI/0.1 (+personal-assistant research tool)" },
      signal: ctx.signal,
      maxRedirections: 3,
    });

    const contentType = res.headers["content-type"]?.toString() ?? "";
    const raw = await res.body.text();
    const text = contentType.includes("html") ? stripHtml(raw) : raw;

    return {
      output: {
        url: input.url,
        status: res.statusCode,
        contentType,
        content: text.slice(0, input.maxLength),
        truncated: text.length > input.maxLength,
      },
      // Retrieved from the open web — never treated as an instruction (Section 66).
      untrusted: true,
    };
  },
};
