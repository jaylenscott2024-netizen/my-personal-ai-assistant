import { prisma } from "../database/client.js";
import { ValidationError } from "../utils/errors.js";

// Section 20-22: Memory System. Categories map to the conceptual
// ShortTermMemory/LongTermMemory/UserPreferences/ProjectMemory/TaskMemory
// split from the spec — we model them as one table with a `category`
// column rather than five parallel tables, since they share every other
// field (importance, provenance, retrieval) and the category is exactly
// the dimension retrieval already has to weight on.
export type MemoryCategory = "preference" | "project" | "task" | "fact" | "instruction";
export type MemoryProvenance = "user_stated" | "inferred" | "task_result";

export interface CreateMemoryInput {
  userId: string;
  category: MemoryCategory;
  content: string;
  key?: string;
  importance?: number; // 1-5
  provenance: MemoryProvenance;
  scope?: string;
}

const VALID_CATEGORIES: MemoryCategory[] = ["preference", "project", "task", "fact", "instruction"];

export async function createMemory(input: CreateMemoryInput) {
  if (!VALID_CATEGORIES.includes(input.category)) {
    throw new ValidationError(`Invalid memory category "${input.category}".`);
  }
  const importance = input.importance ?? 3;
  if (importance < 1 || importance > 5) {
    throw new ValidationError("importance must be between 1 and 5.");
  }
  return prisma.memoryItem.create({
    data: {
      userId: input.userId,
      category: input.category,
      content: input.content,
      key: input.key,
      importance,
      provenance: input.provenance,
      scope: input.scope,
    },
  });
}

// Backs the memory_remember tool (tools/builtin/memoryTools.ts) — the
// model's own way to make something persist past the current
// conversation, which is what "the user shouldn't have to repeat
// themselves" and "incorporate a correction" actually require: neither is
// achievable from prompt instructions alone if there is no way to WRITE
// memory, only read it.
//
// Upserts by (userId, key) when a key is given, rather than always
// creating a new row. This is specifically what makes correction handling
// work: telling Jarvis "actually, I prefer email over Slack" after it
// already remembered "prefers Slack" under the key "contact_preference"
// replaces that memory instead of leaving two contradictory ones for
// retrieval to arbitrarily rank against each other. A key is optional —
// one-off facts with no natural stable identity are simply appended.
export async function rememberFact(input: CreateMemoryInput): Promise<{ item: Awaited<ReturnType<typeof createMemory>>; replacedExisting: boolean }> {
  if (!VALID_CATEGORIES.includes(input.category)) {
    throw new ValidationError(`Invalid memory category "${input.category}".`);
  }
  const importance = input.importance ?? 3;
  if (importance < 1 || importance > 5) {
    throw new ValidationError("importance must be between 1 and 5.");
  }

  if (input.key) {
    const existing = await prisma.memoryItem.findFirst({
      where: { userId: input.userId, key: input.key, disabled: false },
    });
    if (existing) {
      const item = await prisma.memoryItem.update({
        where: { id: existing.id },
        data: { content: input.content, importance, provenance: input.provenance, category: input.category, scope: input.scope },
      });
      return { item, replacedExisting: true };
    }
  }

  return { item: await createMemory(input), replacedExisting: false };
}

export async function updateMemory(
  userId: string,
  id: string,
  updates: Partial<Pick<CreateMemoryInput, "content" | "importance" | "scope">> & { disabled?: boolean },
) {
  const existing = await prisma.memoryItem.findFirst({ where: { id, userId } });
  if (!existing) throw new ValidationError("Memory item not found.");
  return prisma.memoryItem.update({ where: { id }, data: updates });
}

export async function deleteMemory(userId: string, id: string): Promise<void> {
  await prisma.memoryItem.deleteMany({ where: { id, userId } });
}

export async function listMemory(userId: string, category?: MemoryCategory) {
  return prisma.memoryItem.findMany({
    where: { userId, category, disabled: false },
    orderBy: { updatedAt: "desc" },
  });
}

export interface MemoryRetrievalOptions {
  query?: string;
  scope?: string;
  limit?: number;
}

// Section 21: Memory Retrieval. This is a deliberately simple relevance
// model (recency + importance + naive lexical overlap with the query) —
// good enough to keep irrelevant memories out of context without pulling
// in a vector database dependency. A future upgrade path (embeddings +
// pgvector/similar) can replace `lexicalScore` without touching callers.
function lexicalScore(content: string, query?: string): number {
  if (!query) return 0;
  const queryTokens = new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(content.toLowerCase().split(/\W+/));
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits++;
  }
  return hits / queryTokens.size;
}

function recencyScore(date: Date): number {
  const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  return 1 / (1 + ageDays / 14); // half-relevance around two weeks
}

export async function retrieveRelevantMemory(userId: string, options: MemoryRetrievalOptions = {}) {
  const limit = options.limit ?? 8;
  const candidates = await prisma.memoryItem.findMany({
    where: { userId, disabled: false, scope: options.scope ?? undefined },
    orderBy: { updatedAt: "desc" },
    take: 200, // bounded candidate pool so scoring stays cheap
  });

  const scored = candidates
    .map((item) => {
      const overlap = lexicalScore(item.content, options.query);
      const score = 0.45 * (item.importance / 5) + 0.25 * recencyScore(item.updatedAt) + 0.3 * overlap;
      return { item, score, overlap };
    })
    // When a query is given, importance/recency alone must never be enough
    // to surface a memory with zero actual topical overlap — otherwise
    // every sufficiently important item would leak into every unrelated
    // conversation, which is exactly the flooding this retrieval exists to
    // prevent. Without a query (e.g. "what should I know about this user
    // right now"), importance/recency ranking alone is the intended mode.
    .filter((s) => !options.query || s.overlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: scored.map((s) => s.item.id) } },
      data: { lastUsedAt: new Date() },
    });
  }

  return scored.map((s) => s.item);
}
