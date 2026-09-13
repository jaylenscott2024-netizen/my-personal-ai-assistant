import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// Configuration is centralized and validated at startup. Every variable a
// deployer might need is documented in .env.example. Nothing here has a
// hard-coded secret; anything sensitive is read from the environment or, at
// runtime, from the encrypted Credential store (see security/credentials.ts).
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters")
    .default("dev-insecure-secret-change-me-32chars"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .min(32, "CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters (used to derive an AES-256 key)")
    .default("dev-insecure-encryption-key-change-me!!"),

  // AI providers — optional. Absence means that provider is reported
  // "not_configured", never faked.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  // Declared ceilings for Gemini's visual transports, NOT properties of
  // the Eyes engine itself — local perception runs at whatever rate the OS
  // reports events, entirely independent of these (see EYES.md). Defaults
  // match Gemini's documented 1 fps video sampling; raise them if your
  // model/tier serves more. The Live session negotiates the effective rate
  // at setup and uses the lower of declared vs. accepted.
  GEMINI_VIDEO_FPS: z.coerce.number().positive().max(60).default(1),
  GEMINI_REALTIME_VISUAL_FPS: z.coerce.number().positive().max(60).default(1),
  DEFAULT_AI_PROVIDER: z.enum(["anthropic", "openai", "gemini", "mock"]).default("mock"),

  // Voice
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_DEFAULT_VOICE_ID: z.string().optional(),

  // Business integrations — all optional, real interfaces gated on these.
  GITHUB_TOKEN: z.string().optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),

  // Agent loop protection
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(12),
  AGENT_MAX_EXECUTION_MS: z.coerce.number().int().positive().default(120_000),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(20),
  AGENT_APPROVAL_WAIT_MS: z.coerce.number().int().positive().default(15_000),

  // Filesystem tool sandbox
  FILESYSTEM_TOOL_ROOT: z.string().default("./data/workspace"),

  // Section 8: computer.execute is never bare shell access. Only
  // executable names in this comma-separated allowlist may ever run,
  // regardless of what the model requests — empty by default, so an
  // operator must explicitly opt an executable in.
  COMPUTER_COMMAND_ALLOWLIST: z.string().default(""),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppEnv = z.infer<typeof envSchema>;

// Exposes the schema's own defaults (e.g. for a test asserting
// "secure by default" without needing to fight the fact that `env` below
// is a frozen singleton parsed once at import time).
export const envSchemaDefaults: AppEnv = envSchema.parse({});

function loadEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  if (parsed.data.NODE_ENV === "production") {
    const insecureDefaults: Array<[string, string]> = [
      ["JWT_SECRET", "dev-insecure-secret-change-me-32chars"],
      ["CREDENTIAL_ENCRYPTION_KEY", "dev-insecure-encryption-key-change-me!!"],
    ];
    for (const [key, insecureValue] of insecureDefaults) {
      if ((parsed.data as Record<string, unknown>)[key] === insecureValue) {
        // eslint-disable-next-line no-console
        console.error(`Refusing to start in production with the default ${key}. Set a real secret.`);
        process.exit(1);
      }
    }
  }

  return parsed.data;
}

export const env = loadEnv();
