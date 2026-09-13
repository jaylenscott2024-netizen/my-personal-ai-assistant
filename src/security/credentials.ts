import crypto from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../database/client.js";
import { NotConfiguredError } from "../utils/errors.js";

// Section 19/67: API key management + secret isolation. Third-party
// credentials configured by a user through the API (rather than an
// operator-level env var) are encrypted at rest with AES-256-GCM. The
// derived key never leaves this module, and decrypted secrets are only
// ever handed to the specific integration client that needs them — never
// returned to the model, an API response, or a log line.
function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(env.CREDENTIAL_ENCRYPTION_KEY).digest();
}

export function encryptSecret(plaintext: string): { secretEnc: string; secretIv: string; secretTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    secretEnc: encrypted.toString("base64"),
    secretIv: iv.toString("base64"),
    secretTag: tag.toString("base64"),
  };
}

export function decryptSecret(record: { secretEnc: string; secretIv: string; secretTag: string }): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(record.secretIv, "base64"));
  decipher.setAuthTag(Buffer.from(record.secretTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.secretEnc, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export async function getUserCredentialSecret(
  userId: string,
  provider: string,
  label?: string,
): Promise<string> {
  const record = await prisma.credential.findFirst({
    where: { userId, provider, label: label ?? null },
  });
  if (!record) {
    throw new NotConfiguredError(`Credential for provider "${provider}"`);
  }
  return decryptSecret(record);
}

export async function upsertUserCredential(
  userId: string,
  provider: string,
  secret: string,
  options?: { label?: string; metadata?: Record<string, unknown> },
): Promise<{ id: string; provider: string; label: string | null }> {
  const { secretEnc, secretIv, secretTag } = encryptSecret(secret);
  const label = options?.label ?? null;

  // Prisma's compound-unique `where` shorthand (userId_provider_label)
  // requires every field to be non-null, which a nullable `label` column
  // violates whenever no label is given — so we do the find-then-write by
  // hand instead of using `upsert` directly.
  const existing = await prisma.credential.findFirst({ where: { userId, provider, label } });
  const data = {
    secretEnc,
    secretIv,
    secretTag,
    metadata: options?.metadata ? JSON.stringify(options.metadata) : null,
  };

  const record = existing
    ? await prisma.credential.update({ where: { id: existing.id }, data })
    : await prisma.credential.create({ data: { userId, provider, label, ...data } });

  return { id: record.id, provider: record.provider, label: record.label };
}
