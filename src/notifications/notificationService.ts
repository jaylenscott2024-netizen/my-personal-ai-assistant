import { prisma } from "../database/client.js";
import { emailIntegration } from "../integrations/email.js";
import { realtimeGateway } from "../realtime/gateway.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("notifications");

// Section 44: Notification System. "desktop" notifications are delivered
// over the existing WebSocket activity stream (Section 47) rather than a
// separate push mechanism — there is no separate desktop client push
// channel to build here. Email is a real SMTP send when configured;
// otherwise the notification is recorded as failed with an honest reason,
// never silently dropped or faked as sent.
export type NotificationChannel = "desktop" | "email";

export async function notifyUser(userId: string, channel: NotificationChannel, title: string, body: string) {
  const record = await prisma.notification.create({ data: { userId, channel, title, body, status: "pending" } });

  try {
    if (channel === "desktop") {
      realtimeGateway.sendToUser(userId, { type: "notification", title, body, notificationId: record.id });
      await prisma.notification.update({ where: { id: record.id }, data: { status: "sent", sentAt: new Date() } });
    } else if (channel === "email") {
      if (!emailIntegration.isConfigured()) {
        throw new Error("Email is not configured; cannot deliver email notification.");
      }
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error("User not found.");
      await emailIntegration.send(user.email, title, body);
      await prisma.notification.update({ where: { id: record.id }, data: { status: "sent", sentAt: new Date() } });
    }
  } catch (err) {
    log.warn({ err, channel }, "notification delivery failed");
    await prisma.notification.update({ where: { id: record.id }, data: { status: "failed" } });
  }

  return record;
}

export async function listNotifications(userId: string) {
  return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
}
