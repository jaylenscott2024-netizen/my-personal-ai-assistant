import { describe, it, expect } from "vitest";
import { createMemory, retrieveRelevantMemory, deleteMemory, rememberFact, listMemory } from "../src/memory/memoryService.js";
import { registerUser } from "../src/auth/authService.js";

async function makeUser() {
  const email = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const result = await registerUser(email, "a-strong-password");
  return result.user.id;
}

describe("memoryService", () => {
  it("ranks memory relevant to the query above irrelevant memory", async () => {
    const userId = await makeUser();
    await createMemory({ userId, category: "preference", content: "The user prefers dark mode and concise answers.", provenance: "user_stated", importance: 4 });
    await createMemory({ userId, category: "fact", content: "The user's favorite color is blue and they like hiking.", provenance: "inferred", importance: 2 });

    const results = await retrieveRelevantMemory(userId, { query: "What theme does the user prefer?" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toMatch(/dark mode/);
  });

  it("does not flood results with irrelevant memory when a query is given", async () => {
    const userId = await makeUser();
    await createMemory({ userId, category: "fact", content: "Completely unrelated fact about astronomy.", provenance: "inferred", importance: 1 });

    const results = await retrieveRelevantMemory(userId, { query: "shopify store checkout bug" });
    expect(results.length).toBe(0);
  });

  it("returns important recent memory when no query is given", async () => {
    const userId = await makeUser();
    await createMemory({ userId, category: "instruction", content: "Always confirm before sending emails.", provenance: "user_stated", importance: 5 });

    const results = await retrieveRelevantMemory(userId, {});
    expect(results.length).toBe(1);
  });

  it("excludes deleted memory from retrieval", async () => {
    const userId = await makeUser();
    const item = await createMemory({ userId, category: "fact", content: "Temporary fact to delete.", provenance: "inferred" });
    await deleteMemory(userId, item.id);

    const results = await retrieveRelevantMemory(userId, {});
    expect(results.find((r) => r.id === item.id)).toBeUndefined();
  });

  it("scopes memory to the requesting user only", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    await createMemory({ userId: userA, category: "fact", content: "User A's private business plan details.", provenance: "user_stated", importance: 5 });

    const resultsForB = await retrieveRelevantMemory(userB, { query: "business plan" });
    expect(resultsForB.length).toBe(0);
  });
});

// rememberFact backs the memory_remember tool — the model's own way to
// make a stated preference or a correction persist past the current
// conversation. Its upsert-by-key behavior is specifically what makes
// correction-handling work: a later call with the same key replaces the
// earlier value instead of leaving two memories to contradict each other.
describe("rememberFact — the correction-handling path", () => {
  it("creates a new memory when no key is given", async () => {
    const userId = await makeUser();
    const { item, replacedExisting } = await rememberFact({ userId, category: "fact", content: "Likes their coffee black.", provenance: "user_stated" });

    expect(replacedExisting).toBe(false);
    const all = await listMemory(userId);
    expect(all.map((m) => m.id)).toContain(item.id);
  });

  it("replaces the existing memory under the same key instead of duplicating it", async () => {
    const userId = await makeUser();
    await rememberFact({ userId, category: "preference", content: "Prefers Slack for updates.", key: "contact_preference", provenance: "user_stated" });

    // The user corrects this later in the same or a different conversation.
    const { replacedExisting } = await rememberFact({ userId, category: "preference", content: "Actually prefers email over Slack now.", key: "contact_preference", provenance: "user_stated" });

    expect(replacedExisting).toBe(true);
    const all = await listMemory(userId, "preference");
    const matching = all.filter((m) => m.content.includes("prefers") || m.content.includes("Prefers"));
    expect(matching).toHaveLength(1); // never two contradictory rows under the same key
    expect(matching[0].content).toMatch(/email/);
  });

  it("does not let a disabled memory block a fresh remember under its old key", async () => {
    const userId = await makeUser();
    const { item } = await rememberFact({ userId, category: "fact", content: "Old fact.", key: "shared_key", provenance: "user_stated" });
    await deleteMemory(userId, item.id);

    const { replacedExisting, item: fresh } = await rememberFact({ userId, category: "fact", content: "New fact under the same key.", key: "shared_key", provenance: "user_stated" });

    expect(replacedExisting).toBe(false);
    expect(fresh.id).not.toBe(item.id);
  });

  it("scopes the upsert lookup to the requesting user's own memories", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    await rememberFact({ userId: userA, category: "preference", content: "A's preference.", key: "shared_key_name", provenance: "user_stated" });

    const { replacedExisting } = await rememberFact({ userId: userB, category: "preference", content: "B's preference.", key: "shared_key_name", provenance: "user_stated" });

    expect(replacedExisting).toBe(false); // B has no existing memory under this key — A's is invisible to B
  });
});
