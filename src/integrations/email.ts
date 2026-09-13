import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { NotConfiguredError } from "../utils/errors.js";

function isConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!isConfigured()) throw new NotConfiguredError("Email integration (SMTP_HOST/SMTP_USER/SMTP_PASS)");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

// Section 33: real SMTP email integration. Sending requires email.send
// permission + approval at the tool layer; this module only ever performs
// the actual send when explicitly called with fully-formed content.
export const emailIntegration = {
  isConfigured,

  async send(to: string, subject: string, body: string): Promise<{ messageId: string }> {
    const client = getTransporter();
    const info = await client.sendMail({
      from: env.SMTP_FROM ?? env.SMTP_USER,
      to,
      subject,
      text: body,
    });
    return { messageId: info.messageId };
  },

  async verifyConnection(): Promise<boolean> {
    const client = getTransporter();
    return client.verify();
  },
};
