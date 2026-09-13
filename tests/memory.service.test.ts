import { describe, it, expect } from "vitest";
import { createMemory, retrieveRelevantMemory, deleteMemory } from "../src/memory/memoryService.js";
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
