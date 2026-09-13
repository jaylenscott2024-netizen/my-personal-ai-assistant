import { request } from "undici";
import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";

const API_BASE = "https://api.github.com";

function requireToken(): string {
  if (!env.GITHUB_TOKEN) throw new NotConfiguredError("GitHub integration (GITHUB_TOKEN)");
  return env.GITHUB_TOKEN;
}

async function githubRequest(path: string, init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) {
  const token = requireToken();
  const res = await request(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "Jarvis/0.1",
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.body.json().catch(() => undefined);
  if (res.statusCode >= 400) {
    throw new ProviderError(`GitHub API error (${res.statusCode}): ${JSON.stringify(body)}`, res.statusCode >= 500);
  }
  return body;
}

// Section 38: real GitHub integration. Read operations (search, repo/issue
// inspection) require no approval; write operations (creating issues) are
// exposed separately so the approval engine can gate them (Section 38:
// "write operations must be permission-controlled").
export const githubIntegration = {
  isConfigured: () => Boolean(env.GITHUB_TOKEN),

  async searchCode(query: string) {
    return githubRequest(`/search/code?q=${encodeURIComponent(query)}`);
  },

  // owner/repo reach here as free-form, model-supplied strings (see
  // tools/builtin/integrationTools.ts's githubCreateIssueInput: z.string()
  // with no further restriction) — encoding them is required, not
  // optional, the same way searchCode's query already was. Unencoded, a
  // value like "foo/../../rate_limit" or "foo?extra=1" could alter which
  // GitHub API path or query parameters this request actually hits,
  // using whatever scope GITHUB_TOKEN happens to carry. The tool-level
  // approval gate on createIssue doesn't substitute for this: a reviewer
  // approving "create an issue in owner/repo" has no reason to notice a
  // crafted owner string is doing something other than naming a repo.
  async getRepository(owner: string, repo: string) {
    return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  },

  async listIssues(owner: string, repo: string, state: "open" | "closed" | "all" = "open") {
    return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${encodeURIComponent(state)}`);
  },

  async createIssue(owner: string, repo: string, title: string, body?: string) {
    return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, { method: "POST", body: { title, body } });
  },
};
