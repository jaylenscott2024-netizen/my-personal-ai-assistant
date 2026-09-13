import { getUserCredentialSecret } from "../security/credentials.js";
import { NotConfiguredError } from "../utils/errors.js";

// Section 16 of the Jarvis spec: "integrations must use the correct
// user-scoped credential system where applicable... do not create
// duplicate plaintext credential systems." Voice providers now resolve
// their API key the same way business integrations would: prefer a
// user-configured, encrypted credential (security/credentials.ts) over an
// operator-level environment variable, which remains a valid fallback for
// a single-operator deployment.
export async function resolveApiKey(
  userId: string | undefined,
  credentialProvider: string,
  envValue: string | undefined,
  what: string,
): Promise<string> {
  if (userId) {
    try {
      return await getUserCredentialSecret(userId, credentialProvider);
    } catch (err) {
      if (!(err instanceof NotConfiguredError)) throw err;
      // fall through to the env-level default
    }
  }
  if (envValue) return envValue;
  throw new NotConfiguredError(what);
}
