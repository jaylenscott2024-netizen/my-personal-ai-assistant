import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for a real bug found in review: several
// integrations encoded SOME identifiers into their request URLs
// (searchCode's query, calendarId) but not others (owner/repo, eventId,
// productId, callSid) — even though those others reach here as free-form,
// model-supplied strings via the corresponding tool's z.string() input
// (see tools/builtin/integrationTools.ts). An unencoded value like
// "foo/../../rate_limit" or "foo?extra=1" can alter which path or query
// parameters a request actually hits. undici's `request` is mocked so
// this proves the exact URL built, not just that a call "succeeds."

const requestMock = vi.fn(async (..._args: unknown[]): Promise<{ statusCode: number; body: Record<string, unknown> }> => ({
  statusCode: 200,
  body: { json: async () => ({}), [Symbol.asyncIterator]: async function* () {} },
}));

vi.mock("undici", () => ({
  request: (...args: unknown[]) => (requestMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../src/config/env.js", () => ({
  env: {
    GITHUB_TOKEN: "gh-token",
    SHOPIFY_SHOP_DOMAIN: "shop.myshopify.com",
    SHOPIFY_ADMIN_ACCESS_TOKEN: "shopify-token",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_FROM_NUMBER: "+15550000000",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
    NODE_ENV: "test",
  },
}));

beforeEach(() => {
  requestMock.mockClear();
});

function lastRequestedUrl(): string {
  const calls = requestMock.mock.calls;
  return calls[calls.length - 1]![0] as string;
}

describe("GitHub integration — path segments are encoded", () => {
  it("encodes owner/repo containing path-breaking characters", async () => {
    const { githubIntegration } = await import("../src/integrations/github.js");
    await githubIntegration.createIssue("my/../org", "repo?extra=1", "title");

    const url = lastRequestedUrl();
    expect(url).toContain(encodeURIComponent("my/../org"));
    expect(url).toContain(encodeURIComponent("repo?extra=1"));
    // The literal, unescaped payload must never appear in the URL — that
    // would mean it broke out of its path segment.
    expect(url).not.toContain("/my/../org/");
    expect(url).not.toContain("repo?extra=1/issues");
  });

  it("encodes getRepository's owner/repo the same way", async () => {
    const { githubIntegration } = await import("../src/integrations/github.js");
    await githubIntegration.getRepository("a/b", "c");
    expect(lastRequestedUrl()).toContain(`${encodeURIComponent("a/b")}/${encodeURIComponent("c")}`);
  });
});

describe("Shopify integration — product/inventory ids are encoded", () => {
  it("encodes productId before it enters the URL path", async () => {
    const { shopifyIntegration } = await import("../src/integrations/shopify.js");
    await shopifyIntegration.updateProduct("123?admin=1", { title: "x" });

    const url = lastRequestedUrl();
    expect(url).toContain(encodeURIComponent("123?admin=1"));
    expect(url).not.toContain("123?admin=1.json");
  });

  it("encodes each inventory item id in the query string", async () => {
    const { shopifyIntegration } = await import("../src/integrations/shopify.js");
    await shopifyIntegration.getInventoryLevels(["1", "2&extra=1"]);

    const url = lastRequestedUrl();
    expect(url).toContain(encodeURIComponent("2&extra=1"));
  });
});

describe("Google Calendar integration — eventId is encoded", () => {
  it("encodes eventId the same way calendarId already was", async () => {
    const { googleCalendarIntegration } = await import("../src/integrations/googleCalendar.js");
    // getAccessToken() does its own request first; two calls happen in
    // sequence, so check the final (calendar API) request specifically.
    requestMock.mockImplementationOnce(async () => ({
      statusCode: 200,
      body: { json: async () => ({ access_token: "tok", expires_in: 3600 }) },
    }));
    await googleCalendarIntegration.deleteEvent("evt/../other", "primary");

    const url = lastRequestedUrl();
    expect(url).toContain(encodeURIComponent("evt/../other"));
    expect(url).not.toContain("/events/evt/../other");
  });
});

describe("Twilio integration — callSid is encoded", () => {
  it("encodes callSid before it enters the URL path", async () => {
    const { twilioIntegration } = await import("../src/integrations/twilio.js");
    await twilioIntegration.getCallStatus("CA123?x=1");

    const url = lastRequestedUrl();
    expect(url).toContain(encodeURIComponent("CA123?x=1"));
    expect(url).not.toContain("CA123?x=1.json");
  });
});
