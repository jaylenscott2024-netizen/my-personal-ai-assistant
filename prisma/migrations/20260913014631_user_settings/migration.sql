-- CreateTable
CREATE TABLE "UserSettings" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
