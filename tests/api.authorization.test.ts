import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

// Section 78: security testing — unauthorized users cannot access data,
// and resource ownership is enforced independently of authentication.
describe("API authentication & authorization boundaries", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerAndLogin(email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "a-strong-password" } });
    return JSON.parse(res.body) as { token: string; user: { id: string } };
  }

  it("rejects requests with no bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with a malformed token", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations", headers: { authorization: "Bearer not-a-real-token" } });
    expect(res.statusCode).toBe(401);
  });

  it("does not let one user read another user's conversation", async () => {
    const userA = await registerAndLogin(`a-${Date.now()}@example.com`);
    const userB = await registerAndLogin(`b-${Date.now()}@example.com`);

    const createRes = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { provider: "mock" },
    });
    const conversation = JSON.parse(createRes.body) as { id: string };

    const readAsB = await app.inject({
      method: "GET",
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(readAsB.statusCode).toBe(404); // ownership-scoped lookup — no existence leak beyond 404

    const readAsA = await app.inject({
      method: "GET",
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(readAsA.statusCode).toBe(200);
  });

  it("never returns a stored credential secret in an API response", async () => {
    const user = await registerAndLogin(`c-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "POST",
      url: "/integrations/credentials",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { provider: "shopify", secret: "shpat_super_secret_value" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("shpat_super_secret_value");
  });

  it("rejects a weak password at the API boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `weak-${Date.now()}@example.com`, password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });
});
