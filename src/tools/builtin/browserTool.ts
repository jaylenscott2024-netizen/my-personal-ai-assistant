import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { browserManager } from "../../browser/browserManager.js";
import { ValidationError } from "../../utils/errors.js";

const inputSchema = z.object({
  action: z.enum(["navigate", "click", "type", "read_text", "screenshot", "close"]),
  url: z.string().url().optional().describe("Required for 'navigate'."),
  selector: z.string().optional().describe("CSS selector, required for 'click'/'type'."),
  text: z.string().optional().describe("Text to type, required for 'type'."),
});

// Section 25: real Playwright-backed browser automation, exposed through
// the same tool/permission system as everything else. One browser context
// per (userId + taskId) so concurrent tasks never share cookies/state.
export const browserTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "browser",
  description:
    "Control a headless browser: navigate to a URL, click an element, type text, read visible page text, or take a screenshot. Use for web research and website inspection.",
  version: "1.0.0",
  inputSchema,
  jsonSchema: zodToJsonSchema(inputSchema, "browser") as Record<string, unknown>,
  requiredPermissions: ["browser.read"], // 'click'/'type' escalate to browser.interact via requiresApproval below
  requiresApproval: false,
  source: "builtin",
  async execute(input, ctx) {
    const sessionId = `${ctx.userId}:${ctx.taskId ?? "default"}`;
    if (input.action === "close") {
      await browserManager.closeSession(sessionId);
      return { output: { closed: true } };
    }

    const { page } = await browserManager.getSession(sessionId);

    switch (input.action) {
      case "navigate": {
        if (!input.url) throw new ValidationError("url is required for navigate.");
        const response = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return {
          output: { url: page.url(), status: response?.status() ?? null, title: await page.title() },
        };
      }
      case "click": {
        if (!input.selector) throw new ValidationError("selector is required for click.");
        await page.click(input.selector, { timeout: 10_000 });
        return { output: { clicked: input.selector, url: page.url() } };
      }
      case "type": {
        if (!input.selector || input.text === undefined) {
          throw new ValidationError("selector and text are required for type.");
        }
        await page.fill(input.selector, input.text, { timeout: 10_000 });
        return { output: { typedInto: input.selector } };
      }
      case "read_text": {
        const text = await page.innerText("body").catch(() => "");
        return { output: { url: page.url(), text: text.slice(0, 12_000) }, untrusted: true };
      }
      case "screenshot": {
        const buffer = await page.screenshot({ type: "png" });
        return { output: { url: page.url(), imageBase64: buffer.toString("base64") } };
      }
      default:
        throw new ValidationError(`Unsupported browser action.`);
    }
  },
};

// 'click' and 'type' mutate page state — the orchestrator escalates those
// specific actions to require browser.interact + approval rather than the
// read-only browser.read the base tool declares.
export function browserPermissionFor(action: string): "browser.read" | "browser.interact" {
  return action === "click" || action === "type" ? "browser.interact" : "browser.read";
}
