import { prisma } from "../database/client.js";
import { env } from "../config/env.js";
import { eventBus } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";
import { getProvider } from "../ai/router.js";
import type { AIProvider, ChatMessage, ChatRequest, ChatResponse } from "../ai/types.js";
import { ProviderError } from "../utils/errors.js";
import { toolRegistry } from "../tools/registry.js";
import { resolveEffectivePermissions } from "../tools/permissionResolution.js";
import { hasPermission } from "../security/permissionService.js";
import { riskLevelForPermissions } from "../security/permissions.js";
import { requestApproval, waitForApprovalResolution } from "../approvals/approvalService.js";
import { audit } from "../security/audit.js";
import { assembleSystemPrompt } from "../context/instructions.js";
import { getUserSettings } from "../settings/userSettingsService.js";
import { getVisualContextForModel } from "../eyes/visualContextAdapter.js";
import { resolveVisionTransport } from "../eyes/transport/visionTransportRegistry.js";
import { realtimeSessionKey } from "../eyes/eyesVisionAccess.js";
import type { VisualContext } from "../eyes/visualContext.js";
import { retrieveRelevantMemory } from "../memory/memoryService.js";
import { appendMessage, getHistory } from "../conversation/conversationService.js";
import { registerCancellation, clearCancellation } from "../tasks/taskService.js";
import { AgentLoopLimitError, ValidationError } from "../utils/errors.js";

const log = childLogger("orchestrator");

export interface RunAgentInput {
  userId: string;
  role: string;
  conversationId: string;
  providerId: string;
  model: string;
  userMessage: string;
  taskId?: string;
  /** When true, text deltas are emitted as "message.delta" events on the
   *  event bus as the model generates them (Section 14: streaming
   *  conversation), instead of only the final text once the turn
   *  completes. Tool-call handling, permissions, and approvals are
   *  unaffected either way — this only changes how the model's own text
   *  reaches listeners. */
  stream?: boolean;
  /** Fired once the AgentRun row exists, before the loop starts —
   *  callers that need to cancel a run they don't yet have the id for
   *  (the realtime voice pipeline, for barge-in) capture it here rather
   *  than waiting on the run's promise, which doesn't resolve until the
   *  whole turn completes. */
  onAgentRunCreated?: (agentRunId: string) => void;
}

// Consumes either provider.chat() or provider.chatStream() behind one
// return shape, so the rest of the loop (tool handling, persistence) never
// needs to know which path produced the response. Streaming is skipped
// automatically if the model doesn't support it, rather than erroring.
async function getModelResponse(
  provider: AIProvider,
  request: ChatRequest,
  opts: { stream: boolean; agentRunId: string; userId: string },
): Promise<ChatResponse> {
  if (!opts.stream || !provider.getCapabilities(request.model).streaming) {
    return provider.chat(request);
  }

  let finalResponse: ChatResponse | undefined;
  for await (const event of provider.chatStream(request)) {
    if (event.type === "text_delta") {
      eventBus.emitEvent("message.delta", { agentRunId: opts.agentRunId, delta: event.delta }, opts.userId);
    } else if (event.type === "done") {
      finalResponse = event.response;
    } else if (event.type === "error") {
      throw new ProviderError(event.message, event.recoverable);
    }
  }

  if (!finalResponse) {
    throw new ProviderError("Streaming response ended without a completion event.", true);
  }
  return finalResponse;
}

export interface RunAgentOutcome {
  status: "completed" | "failed" | "waiting_for_approval";
  agentRunId: string;
  finalMessage?: string;
  approvalId?: string;
  error?: string;
}

// Section 9-11: Agent Orchestrator. Implements the full loop —
// context -> memory retrieval -> reasoning -> tool selection -> permission
// check -> execution -> observation -> further reasoning -> final response
// — with explicit, persisted state at every step (Section 10) and hard
// bounds against runaway execution (Section 65).
export async function runAgent(input: RunAgentInput): Promise<RunAgentOutcome> {
  const provider = getProvider(input.providerId);
  if (!provider.isConfigured()) {
    throw new ValidationError(`Provider "${input.providerId}" is not configured.`);
  }

  await appendMessage(input.conversationId, "user", input.userMessage);

  const agentRun = await prisma.agentRun.create({
    data: {
      conversationId: input.conversationId,
      taskId: input.taskId,
      provider: input.providerId,
      model: input.model,
      status: "running",
      maxSteps: env.AGENT_MAX_STEPS,
    },
  });

  const controller = registerCancellation(agentRun.id);
  input.onAgentRunCreated?.(agentRun.id);
  eventBus.emitEvent("agent.started", { agentRunId: agentRun.id }, input.userId);

  try {
    const outcome = await executeLoop(agentRun.id, input, provider, controller.signal);
    return outcome;
  } catch (err) {
    const message = (err as Error).message;
    await prisma.agentRun.update({ where: { id: agentRun.id }, data: { status: "failed", error: message, finishedAt: new Date() } });
    eventBus.emitEvent("agent.failed", { agentRunId: agentRun.id, error: message }, input.userId);
    return { status: "failed", agentRunId: agentRun.id, error: message };
  } finally {
    clearCancellation(agentRun.id);
  }
}

async function executeLoop(
  agentRunId: string,
  input: RunAgentInput,
  provider: ReturnType<typeof getProvider>,
  signal: AbortSignal,
): Promise<RunAgentOutcome> {
  const startedAt = Date.now();
  const [memories, settings] = await Promise.all([
    retrieveRelevantMemory(input.userId, { query: input.userMessage }),
    getUserSettings(input.userId),
  ]);
  const memorySummary = memories.map((m) => `- (${m.category}) ${m.content}`).join("\n");
  const visualContext = await getVisualContextForModel({
    userId: input.userId,
    role: input.role,
    providerId: input.providerId,
    settings,
  });

  const systemPrompt = assembleSystemPrompt({
    assistantName: settings.assistantName,
    userPreferencesSummary: memorySummary || undefined,
    visualContext,
  });

  const history = await getHistory(input.conversationId, 60);
  const messages: ChatMessage[] = [...history];
  const toolDescriptors = toolRegistry.toDescriptors();

  let toolCallCount = 0;
  let step = 0;
  // Visual context produced by a tool on the previous step, waiting to be
  // carried to the model in whatever shape this provider accepts.
  let pendingVisualContext: VisualContext | null = null;

  for (;;) {
    step++;
    if (step > env.AGENT_MAX_STEPS) {
      throw new AgentLoopLimitError(`Agent exceeded the maximum of ${env.AGENT_MAX_STEPS} steps.`);
    }
    if (Date.now() - startedAt > env.AGENT_MAX_EXECUTION_MS) {
      throw new AgentLoopLimitError(`Agent exceeded the maximum execution time of ${env.AGENT_MAX_EXECUTION_MS}ms.`);
    }

    await prisma.agentRun.update({ where: { id: agentRunId }, data: { currentStep: step } });
    eventBus.emitEvent("agent.step", { agentRunId, step }, input.userId);
    eventBus.emitEvent("agent.thinking", { agentRunId }, input.userId);

    let request: ChatRequest = {
      model: input.model,
      systemPrompt,
      messages,
      tools: toolDescriptors,
      maxOutputTokens: 4096,
      signal,
    };

    // Section 13: the orchestrator stays provider-neutral. It does not know
    // whether this model takes images, video, or a live stream — it asks
    // the registry for the transport that fits these capabilities and hands
    // the provider-neutral visual context over. Adding a provider never
    // changes this code.
    if (pendingVisualContext) {
      const transport = resolveVisionTransport(input.providerId, provider.getCapabilities(input.model));
      request = await transport.sendVisualContext({
        visualContext: pendingVisualContext,
        request,
        capabilities: provider.getCapabilities(input.model),
        sessionKey: realtimeSessionKey(input.userId, input.providerId, input.model),
        signal,
      });
      pendingVisualContext = null;
    }

    const response = await getModelResponse(provider, request, {
      stream: Boolean(input.stream),
      agentRunId,
      userId: input.userId,
    });

    if (response.toolCalls.length === 0) {
      await appendMessage(input.conversationId, "assistant", response.content, {
        provider: response.provider,
        model: response.model,
        tokenUsage: response.usage,
      });
      await prisma.agentRun.update({
        where: { id: agentRunId },
        data: { status: "completed", finishedAt: new Date(), finalResult: response.content },
      });
      eventBus.emitEvent("agent.completed", { agentRunId }, input.userId);
      return { status: "completed", agentRunId, finalMessage: response.content };
    }

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    };
    messages.push(assistantMessage);
    await appendMessage(input.conversationId, "assistant", response.content, {
      toolCalls: response.toolCalls,
      provider: response.provider,
      model: response.model,
      tokenUsage: response.usage,
    });

    for (const call of response.toolCalls) {
      toolCallCount++;
      if (toolCallCount > env.AGENT_MAX_TOOL_CALLS) {
        throw new AgentLoopLimitError(`Agent exceeded the maximum of ${env.AGENT_MAX_TOOL_CALLS} tool calls.`);
      }

      const outcome = await executeToolCall(agentRunId, input, call, signal);

      if (outcome.status === "waiting_for_approval") {
        await prisma.agentRun.update({ where: { id: agentRunId }, data: { status: "waiting_for_approval" } });
        return { status: "waiting_for_approval", agentRunId, approvalId: outcome.approvalId };
      }

      // Section 25/27: images are only ever forwarded when (a) the active
      // model's capabilities actually declare vision support, AND (b) the
      // active provider is one the user has explicitly opted in to receive
      // ANY visual data (eyesAllowedProviders — empty by default). A tool
      // (e.g. Eyes) stays entirely provider-agnostic and just reports what
      // it captured; this is the one place that decides whether it's
      // actually allowed to reach the model this turn.
      const vision = provider.getCapabilities(input.model).vision;
      const providerAllowedForVisual = settings.eyesAllowedProviders.includes(input.providerId);
      const toolMessage: ChatMessage = {
        role: "tool",
        content: outcome.contentForModel,
        toolCallId: call.id,
        untrusted: outcome.untrusted,
        images: vision && providerAllowedForVisual ? outcome.images : undefined,
      };
      messages.push(toolMessage);

      // Same allowlist gate as the ambient summary: a provider the user
      // hasn't opted in receives no visual context at all, in any form.
      if (outcome.visualContext && providerAllowedForVisual) {
        pendingVisualContext = outcome.visualContext;
      }
      await appendMessage(input.conversationId, "tool", outcome.contentForModel, { toolCallId: call.id });
    }
  }
}

interface ToolCallOutcome {
  status: "executed" | "waiting_for_approval";
  contentForModel: string;
  untrusted?: boolean;
  approvalId?: string;
  /** Carried straight from ToolExecutionResult.images — never persisted;
   *  executeLoop decides whether the active model can actually use it. */
  images?: Array<{ mimeType: string; base64: string }>;
  /** Provider-neutral temporal visual context from an Eyes tool. Routed
   *  through this provider's vision transport adapter on the next model
   *  call; never persisted. */
  visualContext?: VisualContext;
}

async function executeToolCall(
  agentRunId: string,
  input: RunAgentInput,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  signal: AbortSignal,
): Promise<ToolCallOutcome> {
  const record = await prisma.toolCallRecord.create({
    data: { agentRunId, toolName: call.name, input: JSON.stringify(call.arguments), status: "pending" },
  });
  eventBus.emitEvent("tool.started", { agentRunId, toolCallId: record.id, tool: call.name }, input.userId);

  // Section 15/99: tool must exist and its declared source is validated by
  // the registry; unknown tools never silently no-op.
  if (!toolRegistry.has(call.name)) {
    const message = `Unknown tool "${call.name}".`;
    await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "failed", error: message, finishedAt: new Date() } });
    eventBus.emitEvent("tool.failed", { agentRunId, toolCallId: record.id, tool: call.name, error: message }, input.userId);
    return { status: "executed", contentForModel: JSON.stringify({ error: message }) };
  }
  const tool = toolRegistry.get(call.name);

  // Section 99: AI output validation — the model's arguments are never
  // trusted; they are schema-validated before anything touches a real
  // system.
  const parsed = tool.inputSchema.safeParse(call.arguments);
  if (!parsed.success) {
    const message = `Invalid arguments for tool "${call.name}": ${parsed.error.message}`;
    await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "failed", error: message, finishedAt: new Date() } });
    eventBus.emitEvent("tool.failed", { agentRunId, toolCallId: record.id, tool: call.name, error: message }, input.userId);
    return { status: "executed", contentForModel: JSON.stringify({ error: message }) };
  }

  const effectivePermissions = resolveEffectivePermissions(call.name, call.arguments, tool.requiredPermissions);

  const missing = effectivePermissions.filter((p) => !hasPermission(input.role, p));
  if (missing.length > 0) {
    const message = `Permission denied: missing ${missing.join(", ")}.`;
    await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "denied", error: message, finishedAt: new Date() } });
    audit({ userId: input.userId, action: "tool.permission_denied", resource: call.name, outcome: "denied", detail: { missing } });
    eventBus.emitEvent("tool.failed", { agentRunId, toolCallId: record.id, tool: call.name, error: message }, input.userId);
    return { status: "executed", contentForModel: JSON.stringify({ error: message }) };
  }

  const riskLevel = riskLevelForPermissions(effectivePermissions);
  const needsApproval = tool.requiresApproval || riskLevel === "high" || riskLevel === "critical";

  if (needsApproval) {
    const approval = await requestApproval({
      userId: input.userId,
      taskId: input.taskId,
      tool: call.name,
      action: call.name,
      parameters: call.arguments,
      permissions: effectivePermissions,
    });
    await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "pending", approvalId: approval.id, riskLevel } });

    // Bounded wait: the HTTP request that triggered this agent run should
    // not hang indefinitely on a human decision (Section 13). If nobody
    // resolves it within the short window, we hand control back to the
    // caller as "waiting_for_approval" rather than blocking.
    const resolution = await waitForApprovalResolution(approval.id, env.AGENT_APPROVAL_WAIT_MS);
    if (resolution === "timeout") {
      return { status: "waiting_for_approval", contentForModel: "", approvalId: approval.id };
    }
    if (resolution === "denied") {
      const message = "The user denied approval for this action.";
      await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "denied", finishedAt: new Date() } });
      return { status: "executed", contentForModel: JSON.stringify({ error: message }) };
    }
  }

  await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "executing", riskLevel } });

  try {
    const result = await tool.execute(parsed.data, { userId: input.userId, taskId: input.taskId, signal });
    await prisma.toolCallRecord.update({
      where: { id: record.id },
      data: { status: "succeeded", output: JSON.stringify(result.output), finishedAt: new Date() },
    });
    audit({ userId: input.userId, action: "tool.executed", resource: call.name, outcome: "allowed" });
    eventBus.emitEvent("tool.completed", { agentRunId, toolCallId: record.id, tool: call.name }, input.userId);
    return {
      status: "executed",
      contentForModel: JSON.stringify(result.output),
      untrusted: result.untrusted,
      images: result.images,
      visualContext: result.visualContext,
    };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.toolCallRecord.update({ where: { id: record.id }, data: { status: "failed", error: message, finishedAt: new Date() } });
    log.warn({ err, tool: call.name }, "tool execution failed");
    eventBus.emitEvent("tool.failed", { agentRunId, toolCallId: record.id, tool: call.name, error: message }, input.userId);
    return { status: "executed", contentForModel: JSON.stringify({ error: message }) };
  }
}

// Section 17: resumes an agent run after a human resolves the approval it
// was waiting on, re-entering the same loop rather than starting over.
export async function resumeAgentRun(agentRunId: string, userId: string, role: string): Promise<RunAgentOutcome> {
  const run = await prisma.agentRun.findUnique({ where: { id: agentRunId } });
  if (!run || !run.conversationId) throw new ValidationError("Agent run not found or has no conversation.");
  if (run.status !== "waiting_for_approval") {
    throw new ValidationError(`Agent run is not waiting for approval (status: ${run.status}).`);
  }

  const pendingCall = await prisma.toolCallRecord.findFirst({
    where: { agentRunId, status: { in: ["pending"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!pendingCall?.approvalId) throw new ValidationError("No pending approval found for this agent run.");

  const approval = await prisma.approval.findUnique({ where: { id: pendingCall.approvalId } });
  if (!approval || approval.status === "pending") {
    throw new ValidationError("The approval for this agent run has not been resolved yet.");
  }

  const controller = registerCancellation(agentRunId);
  try {
    if (approval.status === "denied") {
      await prisma.toolCallRecord.update({ where: { id: pendingCall.id }, data: { status: "denied", finishedAt: new Date() } });
      await appendMessage(run.conversationId, "tool", JSON.stringify({ error: "The user denied approval for this action." }), {
        toolCallId: pendingCall.id,
      });
    } else {
      const tool = toolRegistry.get(pendingCall.toolName);
      const args = JSON.parse(pendingCall.input);
      await prisma.toolCallRecord.update({ where: { id: pendingCall.id }, data: { status: "executing" } });
      try {
        const result = await tool.execute(args, { userId, taskId: run.taskId ?? undefined, signal: controller.signal });
        await prisma.toolCallRecord.update({
          where: { id: pendingCall.id },
          data: { status: "succeeded", output: JSON.stringify(result.output), finishedAt: new Date() },
        });
        await appendMessage(run.conversationId, "tool", JSON.stringify(result.output), { toolCallId: pendingCall.id });
      } catch (err) {
        const message = (err as Error).message;
        await prisma.toolCallRecord.update({ where: { id: pendingCall.id }, data: { status: "failed", error: message, finishedAt: new Date() } });
        await appendMessage(run.conversationId, "tool", JSON.stringify({ error: message }), { toolCallId: pendingCall.id });
      }
    }

    await prisma.agentRun.update({ where: { id: agentRunId }, data: { status: "running" } });

    const provider = getProvider(run.provider);
    return await executeLoop(
      agentRunId,
      { userId, role, conversationId: run.conversationId, providerId: run.provider, model: run.model, userMessage: "", taskId: run.taskId ?? undefined },
      provider,
      controller.signal,
    );
  } finally {
    clearCancellation(agentRunId);
  }
}
