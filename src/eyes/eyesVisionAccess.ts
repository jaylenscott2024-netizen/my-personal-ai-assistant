import { hasPermission } from "../security/permissionService.js";
import type { UserSettings } from "../settings/userSettingsService.js";
import { eyesService } from "./eyesService.js";
import type { VisualPerceptionEngine } from "./visualPerceptionEngine.js";

export type VisualAccessDenialReason =
  | "eyes_disabled"
  | "no_permission"
  | "provider_not_allowed"
  | "engine_not_running"
  | "nothing_observed";

export interface VisualAccessDecision {
  allowed: boolean;
  reason?: VisualAccessDenialReason;
  engine: VisualPerceptionEngine | null;
}

export interface VisualAccessParams {
  userId: string;
  role: string;
  /** The AI provider about to receive something derived from Eyes. */
  providerId: string;
  settings: UserSettings;
}

// The one place that decides whether anything derived from Eyes may reach
// a given AI provider on a given turn. Every gate is re-evaluated per call
// (never cached), so revoking a provider or disabling Eyes mid-conversation
// takes effect on the very next turn.
//
// Note the ordering: the provider allowlist is checked for ALL visual
// context, text summaries included — "which providers may know what's on
// my screen" is a privacy decision, not a pixels-only one.
export async function resolveVisualAccess(params: VisualAccessParams): Promise<VisualAccessDecision> {
  if (!params.settings.eyesEnabled) return { allowed: false, reason: "eyes_disabled", engine: null };
  if (!hasPermission(params.role, "computer.eyes.read")) return { allowed: false, reason: "no_permission", engine: null };
  if (!params.settings.eyesAllowedProviders.includes(params.providerId)) {
    return { allowed: false, reason: "provider_not_allowed", engine: null };
  }

  const engine = await eyesService.getEngineIfRunning(params.userId);
  if (!engine) return { allowed: false, reason: "engine_not_running", engine: null };
  if (!engine.getState().initialized) return { allowed: false, reason: "nothing_observed", engine };

  return { allowed: true, engine };
}

/** Stable session key for a live visual transport, scoped per user so one
 *  user's stream can never be handed to another's session. */
export function realtimeSessionKey(userId: string, providerId: string, model: string): string {
  return `${userId}::${providerId}::${model}`;
}

export function userIdFromSessionKey(key: string): string {
  return key.split("::")[0] ?? "";
}
