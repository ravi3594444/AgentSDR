/**
 * The channels a CRM conversation, message or draft runs on, and the
 * per-channel facts the CRM needs in more than one place. Pure and
 * client-safe; schema.ts re-exports the type. Every switch here is
 * exhaustive, so adding a channel fails the build until each one says what
 * the new channel does.
 *
 * "whatsapp" is WhatsApp messaging through Unipile
 * (src/lib/whatsapp/crmBridge.ts); on a record it is also where call
 * follow-ups from WhatsApp Calling are worked (src/lib/calls/crmFollowUp.ts).
 *
 * "instagram" is Instagram direct messages through Unipile
 * (src/lib/instagram/crmBridge.ts), only for organizations that turned the
 * Instagram feature on; a reply goes into the chat the lead wrote in.
 *
 * "browser" is a direct message sent through the owner's own signed-in
 * Chrome on X, Instagram, Facebook or LinkedIn (src/lib/browserOutreach/):
 * the account ref is "<site>:<the owner's handle there>", and replies are
 * read from the conversation in that browser, since those sites send no
 * webhook.
 */
export const CRM_CHANNELS = ["email", "linkedin", "whatsapp", "instagram", "browser"] as const;
export type CrmChannel = (typeof CRM_CHANNELS)[number];

export function isCrmChannel(value: unknown): value is CrmChannel {
  return typeof value === "string" && (CRM_CHANNELS as readonly string[]).includes(value);
}

export function crmChannelLabel(channel: CrmChannel): string {
  switch (channel) {
    case "email":
      return "Email";
    case "linkedin":
      return "LinkedIn";
    case "whatsapp":
      return "WhatsApp";
    case "instagram":
      return "Instagram";
    case "browser":
      return "Browser";
  }
}

/** Who delivers a CRM draft on this channel (crm_send_attempts.provider). */
export function crmChannelSendProvider(channel: CrmChannel): "gmail" | "unipile" | "browser" {
  switch (channel) {
    case "email":
      return "gmail";
    case "linkedin":
    case "whatsapp":
    case "instagram":
      return "unipile";
    case "browser":
      return "browser";
  }
}

/** Whether a message on this channel carries a subject line. */
export function crmChannelHasSubject(channel: CrmChannel): boolean {
  switch (channel) {
    case "email":
      return true;
    case "linkedin":
    case "whatsapp":
    case "instagram":
    case "browser":
      return false;
  }
}
