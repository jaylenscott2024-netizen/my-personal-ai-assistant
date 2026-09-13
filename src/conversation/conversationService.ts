import { prisma } from "../database/client.js";
import { NotFoundError } from "../utils/errors.js";
import { eventBus } from "../events/eventBus.js";
import type { ChatMessage, ToolCallRequest } from "../ai/types.js";

export async function createConversation(userId: string, title?: string, provider?: string, model?: string) {
  const conversation = await prisma.conversation.create({
    data: { userId, title, provider, model },
  });
  eventBus.emitEvent("conversation.created", { conversationId: conversation.id }, userId);
  return conversation;
}

export async function getConversation(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
  if (!conversation) throw new NotFoundError("Conversation not found.");
  return conversation;
}

export async function listConversations(userId: string) {
  return prisma.conversation.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
}

export async function appendMessage(
  conversationId: string,
  role: ChatMessage["role"],
  content: string,
  opts?: { toolCalls?: ToolCallRequest[]; toolCallId?: string; provider?: string; model?: string; tokenUsage?: { promptTokens: number; completionTokens: number } },
) {
  const message = await prisma.message.create({
    data: {
      conversationId,
      role,
      content,
      toolCallsJson: opts?.toolCalls?.length ? JSON.stringify(opts.toolCalls) : null,
      toolCallId: opts?.toolCallId,
      provider: opts?.provider,
      model: opts?.model,
      tokenUsage: opts?.tokenUsage ? JSON.stringify(opts.tokenUsage) : null,
    },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  eventBus.emitEvent("message.created", { conversationId, messageId: message.id, role });
  return message;
}

export async function getHistory(conversationId: string, limit = 40): Promise<ChatMessage[]> {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return messages.map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
    toolCalls: m.toolCallsJson ? (JSON.parse(m.toolCallsJson) as ToolCallRequest[]) : undefined,
    toolCallId: m.toolCallId ?? undefined,
  }));
}
