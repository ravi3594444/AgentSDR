/**
 * Where each lead of an outreach run stands, in plain words, from the
 * channel engine's own status for that lead, the run's membership and the
 * CRM's classification of any reply. Pure, so the wording is tested.
 */

export type LeadProgressInput = {
  channel: string;
  runStatus: string;
  emailStatus: string | null;
  whatsappStatus: string | null;
  whatsappSentAt: string | null;
  whatsappError: string | null;
  /** The latest campaign message's provider-reported delivery and read receipt (Unipile's flags), when recorded. */
  whatsappDeliveredAt?: string | null;
  whatsappReadAt?: string | null;
  linkedinStatus: string | null;
  /** When the LinkedIn invitation went out; kept after a stop cancels the lead. */
  linkedinRequestSentAt?: string | null;
  instagramStatus?: string | null;
  instagramError?: string | null;
  category: string | null;
  subcategory: string | null;
};

export type LeadProgress = { tone: "waiting" | "sent" | "replied" | "good" | "stopped" | "failed"; text: string };

const EMAIL_SENT = new Set(["initial_sent", "in_follow_up", "reply_processing", "reply_received", "sequence_completed"]);
const EMAIL_REPLIED = new Set(["reply_processing", "reply_received"]);
const LINKEDIN_SENT = new Set(["REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT", "REPLIED", "COMPLETED"]);

/**
 * Whether a lead was contacted (a message at least accepted for sending;
 * an uncertain or failed send is not one) and whether it replied, from the
 * evidence a stop leaves in place: a stopped WhatsApp lead keeps its last
 * send time, a cancelled LinkedIn lead its invitation time. An opt-out is a
 * reply to a message that went out.
 */
export function leadReach(input: LeadProgressInput): { contacted: boolean; replied: boolean } {
  const replied = input.runStatus === "opted_out" || Boolean(input.category)
    || input.whatsappStatus === "replied" || input.linkedinStatus === "REPLIED" || input.instagramStatus === "replied"
    || EMAIL_REPLIED.has(input.emailStatus ?? "");
  const contacted = replied || (input.channel === "email" && EMAIL_SENT.has(input.emailStatus ?? ""))
    || (input.channel === "whatsapp" && Boolean(input.whatsappSentAt))
    || (input.channel === "linkedin" && (LINKEDIN_SENT.has(input.linkedinStatus ?? "") || Boolean(input.linkedinRequestSentAt)))
    || (input.channel === "instagram" && input.instagramStatus === "sent");
  return { contacted, replied };
}

const EMAIL_OPEN = new Set(["pending", "initial_sent", "in_follow_up"]);
const WHATSAPP_OPEN = new Set(["queued", "in_sequence"]);
const LINKEDIN_OPEN = new Set(["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT"]);
const INSTAGRAM_OPEN = new Set(["queued", "resolving", "sending"]);

/**
 * Whether the lead's channel engine may still send it something: a first
 * message, a follow-up, or the messages after an invitation is accepted.
 * A lead with no engine row yet (a plan still launching, an inquiry run's
 * member) is open: it is never taken as finished without a record saying so.
 */
export function leadOpen(input: LeadProgressInput): boolean {
  if (input.runStatus === "opted_out") return false;
  const open = (status: string | null | undefined, statuses: ReadonlySet<string>) => status == null || statuses.has(status);
  switch (input.channel) {
    case "email": return open(input.emailStatus, EMAIL_OPEN);
    case "whatsapp": return open(input.whatsappStatus, WHATSAPP_OPEN);
    case "linkedin": return open(input.linkedinStatus, LINKEDIN_OPEN);
    case "instagram": return open(input.instagramStatus, INSTAGRAM_OPEN);
    default: return true;
  }
}

const CATEGORY: Record<string, string> = { interested: "Interested", not_interested: "Not interested", customer: "Customer", other: "Other" };

function replied(input: LeadProgressInput): LeadProgress {
  if (!input.category) return { tone: "replied", text: "Replied" };
  const label = `${CATEGORY[input.category] ?? input.category}${input.subcategory ? ` (${input.subcategory})` : ""}`;
  return { tone: input.category === "interested" || input.category === "customer" ? "good" : "replied", text: `Replied · ${label}` };
}

/**
 * How far the latest WhatsApp message got, strongest evidence first: a read
 * receipt, then delivery as WhatsApp reported it through Unipile, then only
 * accepted for sending. None of them proves the person saw it.
 */
function whatsappEvidence(input: LeadProgressInput): string {
  if (input.whatsappReadAt) return "read receipt received";
  if (input.whatsappDeliveredAt) return "delivered (WhatsApp reported)";
  return "accepted for sending";
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function leadProgress(input: LeadProgressInput): LeadProgress {
  if (input.runStatus === "opted_out") return { tone: "stopped", text: "Asked not to be contacted" };
  if (input.category) return replied(input);
  if (input.channel === "instagram" && input.instagramStatus) {
    switch (input.instagramStatus) {
      case "queued": case "resolving": return { tone: "waiting", text: "Waiting to send the Instagram DM" };
      case "sending": return { tone: "waiting", text: "Submitting the Instagram DM" };
      case "sent": return { tone: "sent", text: "Instagram DM accepted for sending, waiting for a reply" };
      case "replied": return replied(input);
      case "failed": return { tone: "failed", text: `Could not send${input.instagramError ? `: ${input.instagramError}` : ""}` };
      case "uncertain": return { tone: "failed", text: "Delivery uncertain; no automatic resend" };
      case "cancelled": return { tone: "stopped", text: "Instagram DM cancelled" };
    }
  }
  if (input.channel === "email") {
    switch (input.emailStatus) {
      case "pending": return { tone: "waiting", text: "Waiting to send" };
      case "initial_sent": return { tone: "sent", text: "First message sent" };
      case "in_follow_up": return { tone: "sent", text: "Follow-up sent" };
      case "reply_processing":
      case "reply_received": return replied(input);
      case "sequence_completed": return { tone: "sent", text: "All messages sent, no reply" };
      case "bounced": return { tone: "failed", text: "Email bounced" };
      case "suppressed": return { tone: "stopped", text: "Unsubscribed" };
    }
  }
  if (input.channel === "whatsapp") {
    switch (input.whatsappStatus) {
      case "queued": return { tone: "waiting", text: "Waiting to send" };
      case "in_sequence": return input.whatsappSentAt ? { tone: "sent", text: `${capitalized(whatsappEvidence(input))}, waiting for a reply` } : { tone: "waiting", text: "Waiting to send" };
      case "replied": return replied(input);
      case "completed": return { tone: "sent", text: `All messages sent, no reply · last one ${whatsappEvidence(input)}` };
      case "stopped": return { tone: "stopped", text: "Stopped" };
      case "failed":
        // A send whose answer was lost: the engine never resends it on its own.
        if (input.whatsappError && /uncertain/i.test(input.whatsappError)) return { tone: "failed", text: "Delivery uncertain; no automatic resend. Check the chat in WhatsApp Messages" };
        return { tone: "failed", text: `Could not send${input.whatsappError ? `: ${input.whatsappError}` : ""}` };
    }
  }
  if (input.channel === "linkedin") {
    switch (input.linkedinStatus) {
      case "PENDING": return { tone: "waiting", text: "Waiting to send the invitation" };
      case "REQUEST_SENT": return { tone: "sent", text: "Invitation sent" };
      case "CONNECTED": return { tone: "sent", text: "Accepted the invitation" };
      case "ACCEPT_MESSAGE_SENT":
      case "FOLLOW_UP_1_SENT":
      case "FOLLOW_UP_2_SENT":
      case "FOLLOW_UP_3_SENT": return { tone: "sent", text: "Messages sent, waiting for a reply" };
      case "REPLIED": return replied(input);
      case "COMPLETED": return { tone: "sent", text: "All messages sent, no reply" };
      case "FAILED": return { tone: "failed", text: "Could not send" };
      case "CANCELLED": return { tone: "stopped", text: "Stopped" };
    }
  }
  if (input.runStatus === "stopped") return { tone: "stopped", text: "Stopped" };
  // An inquiry run's members wrote first; nothing is sent to them before their reply.
  if (input.channel === "instagram") return { tone: "replied", text: "Wrote in on Instagram" };
  return { tone: "waiting", text: "Not started yet" };
}
