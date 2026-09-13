import { request } from "undici";
import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";

function requireConfig(): { sid: string; token: string; from: string } {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    throw new NotConfiguredError("Twilio integration (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER)");
  }
  return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM_NUMBER };
}

// Section 36: real Twilio Voice integration. Placing a call is a
// consequential, hard-to-undo action (Section 55: idempotency) so callers
// must always go through the phone.call permission + approval gate before
// reaching this module — this module performs no confirmation of its own.
export const twilioIntegration = {
  isConfigured: () => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),

  // `twimlUrl` must point to TwiML (or a webhook returning TwiML) that
  // drives the call — Twilio fetches it once the call connects. Voice AI
  // conversation logic lives behind that endpoint, not in this client.
  async placeCall(to: string, twimlUrl: string): Promise<{ callSid: string; status: string }> {
    const { sid, token, from } = requireConfig();
    const body = new URLSearchParams({ To: to, From: from, Url: twimlUrl });
    const res = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const json = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) {
      throw new ProviderError(`Twilio API error (${res.statusCode}): ${JSON.stringify(json)}`, res.statusCode >= 500);
    }
    return { callSid: String(json.sid), status: String(json.status) };
  },

  async getCallStatus(callSid: string): Promise<{ status: string; duration: string | null }> {
    const { sid, token } = requireConfig();
    const res = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    });
    const json = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) throw new ProviderError(`Twilio API error (${res.statusCode})`, res.statusCode >= 500);
    return { status: String(json.status), duration: json.duration ? String(json.duration) : null };
  },
};
