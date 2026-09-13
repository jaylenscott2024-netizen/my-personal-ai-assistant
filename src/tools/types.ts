import type { ZodTypeAny } from "zod";
import type { Permission } from "../security/permissions.js";

// Section 15: Tool Registry. Every tool — builtin, plugin-provided, or
// MCP-provided — implements this same shape so the agent orchestrator
// never needs to know where a tool came from (Section 41: MCP tools go
// through the same security layer as everything else).
export interface ToolContext {
  userId: string;
  taskId?: string;
  /** Cooperative cancellation — long-running tools (browser, network) must check this. */
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  output: unknown;
  /** True when the tool's own output should be treated as untrusted
   *  external content when it re-enters the model's context (Section 66). */
  untrusted?: boolean;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  version: string;
  /** Zod schema used for real runtime validation of model-supplied args (Section 99). */
  inputSchema: ZodTypeAny;
  /** JSON Schema mirror of inputSchema, handed to the model provider. */
  jsonSchema: Record<string, unknown>;
  requiredPermissions: Permission[];
  /** Tools that touch the outside world in a consequential way require approval by default. */
  requiresApproval: boolean;
  source: "builtin" | "plugin" | "mcp";
  execute: (input: Input, ctx: ToolContext) => Promise<ToolExecutionResult>;
}
