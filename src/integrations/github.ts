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

  async getRepository(owner: string, repo: string) {
    return githubRequest(`/repos/${owner}/${repo}`);
  },

  async listIssues(owner: string, repo: string, state: "open" | "closed" | "all" = "open") {
    return githubRequest(`/repos/${owner}/${repo}/issues?state=${state}`);
  },

  async createIssue(owner: string, repo: string, title: string, body?: string) {
    return githubRequest(`/repos/${owner}/${repo}/issues`, { method: "POST", body: { title, body } });
  },
};
