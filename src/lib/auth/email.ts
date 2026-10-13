import "server-only";
import { BRAND } from "@/lib/brand";

/**
 * Transactional email for authentication — verification, password reset,
 * invitations — through Resend's REST API (POST /emails). This is platform
 * infrastructure, one sender for every organization, so it is configured in
 * env rather than in an organization's Integrations:
 *
 *   RESEND_API_KEY   — re_…
 *   AUTH_EMAIL_FROM  — "22nd X AI Outreach <auth@yourdomain>" on a domain verified in Resend
 *
 * Without RESEND_API_KEY the message is written to the server log instead
 * of being sent — so sign-up and invitations work on a laptop, and an
 * operator who has not set up email yet can still complete their own
 * verification from the logs rather than being locked out. In production
 * that is announced once, loudly: real users would wait for email that never
 * comes, so configure Resend before inviting anyone.
 */

let warnedNoEmailService = false;

export type AuthEmail = { to: string; subject: string; text: string; html: string };

export async function sendAuthEmail(email: AuthEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production" && !warnedNoEmailService) {
      warnedNoEmailService = true;
      console.warn(
        "[auth/email] RESEND_API_KEY is not set: verification, password-reset and invitation emails are written to this log instead of being sent. Set RESEND_API_KEY and AUTH_EMAIL_FROM before inviting anyone.",
      );
    }
    console.log(`[auth/email] (not sent — no RESEND_API_KEY) to=${email.to} subject="${email.subject}"\n${email.text}`);
    return;
  }
  const from = process.env.AUTH_EMAIL_FROM;
  if (!from) throw new Error(`AUTH_EMAIL_FROM is not set — e.g. ${BRAND.name} <auth@yourdomain.com>`);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: email.to, subject: email.subject, text: email.text, html: email.html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend refused the email (${response.status}): ${detail.slice(0, 200)}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One plain, client-safe layout for every auth email: a line of text and a button. */
export function authEmail(input: { to: string; subject: string; intro: string; action: string; url: string; outro?: string }): AuthEmail {
  const outro = input.outro ?? "If you didn't ask for this, you can ignore this email.";
  const text = `${input.intro}\n\n${input.action}: ${input.url}\n\n${outro}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7fa;font-family:Inter,Arial,sans-serif;color:#0e121b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:20px;font-weight:600;padding-bottom:16px">${escapeHtml(BRAND.name)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#525866;padding-bottom:24px">${escapeHtml(input.intro)}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#335cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">${escapeHtml(input.action)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#99a0ae">${escapeHtml(outro)}<br><br>Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(input.url)}</span></td></tr>
</table></td></tr></table></body></html>`;
  return { to: input.to, subject: input.subject, text, html };
}
