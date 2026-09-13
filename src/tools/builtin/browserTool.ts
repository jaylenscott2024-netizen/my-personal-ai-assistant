import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../types.js";
import { browserManager } from "../../browser/browserManager.js";
import { ValidationError } from "../../utils/errors.js";
import { env } from "../../config/env.js";

const inputSchema = z.object({
  action: z.enum([
    "open",
    "navigate",
    "back",
    "forward",
    "click",
    "type",
    "select",
    "read_page",
    "find",
    "download",
    "upload",
    "screenshot",
    "wait",
    "close",
  ]),
  url: z.string().url().optional().describe("Required for 'navigate'."),
  selector: z.string().optional().describe("CSS selector — required for click/type/select/upload, and the trigger element for download."),
  text: z.string().optional().describe("Text to type, required for 'type'."),
  value: z.string().optional().describe("Option value to choose, required for 'select'."),
  query: z.string().optional().describe("Text to search for on the page, required for 'find'."),
  filePath: z.string().optional().describe("Path (inside the assistant's workspace) of the file to upload, required for 'upload'."),
  waitMs: z.number().int().positive().max(30_000).optional().describe("Milliseconds to wait, for 'wait' without a selector."),
});

// Section 6: browser automation, kept deliberately separate from desktop
// automation (tools/builtin/computerTools.ts) — the agent decides which
// one a task needs, sometimes both ("open Chrome and go to GitHub" is a
// computer_open_application call followed by a browser navigate). One
// Playwright BrowserContext per (userId + taskId) so concurrent tasks
// never share cookies/state.
export const browserTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "browser",
  description:
    "Control a headless browser: open/navigate, go back/forward, click, type, select a dropdown option, read the page, find text, download/upload a file, screenshot, wait, or close. Use for web research, website inspection, and browser-based tasks.",
  version: "1.1.0",
  inputSchema,
  jsonSchema: zodToJsonSchema(inputSchema, "browser") as Record<string, unknown>,
  requiredPermissions: ["browser.read"], // mutating actions escalate to browser.interact via browserPermissionFor below
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
      case "open": {
        // A session/page now exists (created above); nothing further to do
        // unless the caller also wants to land somewhere specific — that's
        // a separate 'navigate' call, kept explicit rather than implied.
        return { output: { opened: true, url: page.url() } };
      }
      case "navigate": {
        if (!input.url) throw new ValidationError("url is required for navigate.");
        const response = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return { output: { url: page.url(), status: response?.status() ?? null, title: await page.title() } };
      }
      case "back": {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
        return { output: { url: page.url() } };
      }
      case "forward": {
        await page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });
        return { output: { url: page.url() } };
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
      case "select": {
        if (!input.selector || input.value === undefined) {
          throw new ValidationError("selector and value are required for select.");
        }
        await page.selectOption(input.selector, input.value, { timeout: 10_000 });
        return { output: { selected: input.value, in: input.selector } };
      }
      case "read_page": {
        const text = await page.innerText("body").catch(() => "");
        return { output: { url: page.url(), text: text.slice(0, 12_000) }, untrusted: true };
      }
      case "find": {
        if (!input.query) throw new ValidationError("query is required for find.");
        const locator = page.getByText(input.query, { exact: false });
        const count = await locator.count();
        const samples = await locator
          .first()
          .allTextContents()
          .catch(() => []);
        return { output: { query: input.query, matchCount: count, sample: samples[0]?.slice(0, 500) }, untrusted: true };
      }
      case "download": {
        if (!input.selector) throw new ValidationError("selector (the element that triggers the download) is required.");
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.click(input.selector)]);
        const destDir = path.resolve(env.FILESYSTEM_TOOL_ROOT);
        const destPath = path.join(destDir, download.suggestedFilename());
        await download.saveAs(destPath);
        return { output: { downloaded: download.suggestedFilename(), savedTo: destPath } };
      }
      case "upload": {
        if (!input.selector || !input.filePath) throw new ValidationError("selector and filePath are required for upload.");
        const workspaceRoot = path.resolve(env.FILESYSTEM_TOOL_ROOT);
        const resolved = path.resolve(workspaceRoot, input.filePath);
        if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
          throw new ValidationError("filePath must be inside the assistant's workspace.");
        }
        await page.setInputFiles(input.selector, resolved, { timeout: 10_000 });
        return { output: { uploadedFrom: resolved, into: input.selector } };
      }
      case "screenshot": {
        const buffer = await page.screenshot({ type: "png" });
        return { output: { url: page.url(), imageBase64: buffer.toString("base64") } };
      }
      case "wait": {
        if (input.selector) {
          await page.waitForSelector(input.selector, { timeout: input.waitMs ?? 15_000 });
          return { output: { waitedFor: input.selector } };
        }
        const ms = input.waitMs ?? 1000;
        await page.waitForTimeout(ms);
        return { output: { waitedMs: ms } };
      }
      default:
        throw new ValidationError(`Unsupported browser action.`);
    }
  },
};

// Mutating/interactive actions escalate to browser.interact + approval;
// everything else (navigation, reading, waiting) stays browser.read.
const INTERACT_ACTIONS = new Set(["click", "type", "select", "download", "upload"]);
export function browserPermissionFor(action: string): "browser.read" | "browser.interact" {
  return INTERACT_ACTIONS.has(action) ? "browser.interact" : "browser.read";
}
