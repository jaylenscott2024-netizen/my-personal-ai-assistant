import { request } from "undici";
import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";

// Section 34: real Google Calendar integration via a long-lived OAuth
// refresh token (obtained once, out-of-band, through Google's own consent
// screen — this backend does not implement a browser OAuth redirect flow,
// which is a legitimate v1 scope cut per Section 95: build the real
// interface and validation, be honest about the setup step required).
function requireConfig(): { clientId: string; clientSecret: string; refreshToken: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new NotConfiguredError("Google Calendar integration (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)");
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN };
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 30_000) {
    return cachedAccessToken.token;
  }
  const { clientId, clientSecret, refreshToken } = requireConfig();
  const res = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const json = (await res.body.json()) as Record<string, unknown>;
  if (res.statusCode >= 400) {
    throw new ProviderError(`Google OAuth token refresh failed (${res.statusCode}): ${JSON.stringify(json)}`, false);
  }
  cachedAccessToken = { token: String(json.access_token), expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return cachedAccessToken.token;
}

async function calendarRequest(path: string, init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) {
  const token = await getAccessToken();
  const res = await request(`https://www.googleapis.com/calendar/v3${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.body.json().catch(() => undefined);
  if (res.statusCode >= 400) {
    throw new ProviderError(`Google Calendar API error (${res.statusCode}): ${JSON.stringify(json)}`, res.statusCode >= 500);
  }
  return json;
}

export const googleCalendarIntegration = {
  isConfigured: () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN),

  async listEvents(timeMinIso: string, timeMaxIso: string, calendarId = "primary") {
    return calendarRequest(
      `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMinIso)}&timeMax=${encodeURIComponent(timeMaxIso)}&singleEvents=true&orderBy=startTime`,
    );
  },

  async createEvent(event: { summary: string; description?: string; startIso: string; endIso: string; timezone?: string }, calendarId = "primary") {
    return calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      body: {
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.startIso, timeZone: event.timezone ?? "UTC" },
        end: { dateTime: event.endIso, timeZone: event.timezone ?? "UTC" },
      },
    });
  },

  async deleteEvent(eventId: string, calendarId = "primary") {
    // eventId was the one identifier in this file NOT encoded, unlike
    // calendarId right next to it — an unencoded value could otherwise
    // alter which calendar/event path this DELETE actually targets.
    await calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    return { deleted: true };
  },
};
