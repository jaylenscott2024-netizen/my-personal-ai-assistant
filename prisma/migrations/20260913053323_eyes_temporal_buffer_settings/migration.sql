-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "assistantName" TEXT NOT NULL DEFAULT 'Jarvis',
    "activationMode" TEXT NOT NULL DEFAULT 'push_to_talk',
    "wakeWordPhrase" TEXT NOT NULL DEFAULT 'Jarvis',
    "clapSensitivity" REAL NOT NULL DEFAULT 3.0,
    "clapPattern" TEXT NOT NULL DEFAULT 'double',
    "clapCooldownMs" INTEGER NOT NULL DEFAULT 1500,
    "voiceProvider" TEXT NOT NULL DEFAULT 'elevenlabs',
    "voiceId" TEXT,
    "voiceModel" TEXT,
    "sttProvider" TEXT NOT NULL DEFAULT 'elevenlabs',
    "eyesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "eyesMode" TEXT NOT NULL DEFAULT 'structural_only',
    "eyesAttentionMode" TEXT NOT NULL DEFAULT 'auto',
    "eyesUpdateLatencyPolicy" TEXT NOT NULL DEFAULT 'balanced',
    "eyesAllowedProviders" TEXT NOT NULL DEFAULT '[]',
    "eyesHistorySeconds" INTEGER NOT NULL DEFAULT 120,
    "eyesMaxKeyframes" INTEGER NOT NULL DEFAULT 12,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_UserSettings" ("activationMode", "assistantName", "clapCooldownMs", "clapPattern", "clapSensitivity", "eyesAllowedProviders", "eyesAttentionMode", "eyesEnabled", "eyesMode", "eyesUpdateLatencyPolicy", "id", "sttProvider", "updatedAt", "userId", "voiceId", "voiceModel", "voiceProvider", "wakeWordPhrase") SELECT "activationMode", "assistantName", "clapCooldownMs", "clapPattern", "clapSensitivity", "eyesAllowedProviders", "eyesAttentionMode", "eyesEnabled", "eyesMode", "eyesUpdateLatencyPolicy", "id", "sttProvider", "updatedAt", "userId", "voiceId", "voiceModel", "voiceProvider", "wakeWordPhrase" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
