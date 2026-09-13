import { describe, it, expect } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { notifyUser, listNotifications } from "../src/notifications/notificationService.js";
import { prisma } from "../src/database/client.js";

async function makeUser() {
  const email = `notify-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

// Regression coverage for a real bug found by scripts/jarvis-diagnostic.ts:
// notifyUser() persisted the notification's final status ("sent"/"failed")
// to the database correctly, but returned the in-memory object captured
// before that update — so every caller reading the returned record's
// status saw the original "pending" value forever, regardless of what
// actually happened. These assert the RETURNED object (not just the DB
// row) reflects delivery outcome.
describe("notifyUser — returned record reflects final persisted status", () => {
  it("returns a 'sent' record (not the stale 'pending' one) for a desktop notification", async () => {
    const userId = await makeUser();
    const record = await notifyUser(userId, "desktop", "Test title", "Test body");

    expect(record.status).toBe("sent");
    expect(record.sentAt).not.toBeNull();

    const persisted = await prisma.notification.findUnique({ where: { id: record.id } });
    expect(persisted?.status).toBe("sent");
  });

  it("returns a 'failed' record (not the stale 'pending' one) when email isn't configured", async () => {
    const userId = await makeUser();
    // No SMTP_HOST/SMTP_USER/SMTP_PASS in the test environment, so
    // emailIntegration.isConfigured() is false and delivery must fail
    // honestly rather than being faked as sent.
    const record = await notifyUser(userId, "email", "Test email", "Should not actually send.");

    expect(record.status).toBe("failed");

    const persisted = await prisma.notification.findUnique({ where: { id: record.id } });
    expect(persisted?.status).toBe("failed");
  });

  it("the returned record's id matches what listNotifications() later returns, same final status", async () => {
    const userId = await makeUser();
    const record = await notifyUser(userId, "desktop", "Another title", "Another body");

    const list = await listNotifications(userId);
    const found = list.find((n) => n.id === record.id);
    expect(found?.status).toBe(record.status);
  });
});
