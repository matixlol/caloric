import { config } from "../config";
import { logError, logInfo } from "../logging";

type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

// Delivers transactional email via Resend when RESEND_API_KEY is configured.
// Without it (local dev, or before an email provider is wired up), the message
// is written to the server logs so login codes are still recoverable for the
// handful of known users. Password login does not depend on email delivery.
export async function sendEmail({ to, subject, text, html }: SendEmailInput): Promise<void> {
  if (!config.resendApiKey) {
    logInfo("email.logged", {
      reason: "no_email_provider_configured",
      to,
      subject,
      text,
    });
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.authEmailFrom,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logError(
      "email.send_failed",
      new Error(`Resend responded ${response.status}: ${body.slice(0, 500)}`),
    );
    throw new Error("Failed to send email");
  }
}

export function loginCodeEmail(otp: string): { subject: string; text: string; html: string } {
  const subject = "Your Caloric login code";
  const text = `Your Caloric login code is ${otp}. It expires in 5 minutes.`;
  const html = `<p>Your Caloric login code is <strong style="font-size:20px;letter-spacing:2px">${otp}</strong>.</p><p>It expires in 5 minutes. If you didn't request this, you can ignore this email.</p>`;

  return { subject, text, html };
}
