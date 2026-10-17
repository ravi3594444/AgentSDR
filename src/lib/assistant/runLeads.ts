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
  linkedinStatus: string | null;
  instagramStatus?: string | null;
  instagramError?: string | null;
  category: string | null;
  subcategory: string | null;
};

export type LeadProgress = { tone: "waiting" | "sent" | "replied" | "good" | "stopped" | "failed"; text: string };

const CATEGORY: Record<string, string> = { interested: "Interested", not_interested: "Not interested", customer: "Customer", other: "Other" };

function replied(input: LeadProgressInput): LeadProgress {
  if (!input.category) return { tone: "replied", text: "Replied" };
  const label = `${CATEGORY[input.category] ?? input.category}${input.subcategory ? ` (${input.subcategory})` : ""}`;
  return { tone: input.category === "interested" || input.category === "customer" ? "good" : "replied", text: `Replied · ${label}` };
}

export function leadProgress(input: LeadProgressInput): LeadProgress {
  if (input.runStatus === "opted_out") return { tone: "stopped", text: "Asked not to be contacted" };
  if (input.category) return replied(input);
  if (input.channel === "instagram" && input.instagramStatus) {
    switch (input.instagramStatus) {
      case "queued": case "resolving": return { tone: "waiting", text: "Waiting to send the Instagram DM" };
      case "sending": return { tone: "waiting", text: "Submitting the Instagram DM" };
      case "sent": return { tone: "sent", text: "Instagram DM sent, waiting for a reply" };
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
      case "in_sequence": return input.whatsappSentAt ? { tone: "sent", text: "Message sent, waiting for a reply" } : { tone: "waiting", text: "Waiting to send" };
      case "replied": return replied(input);
      case "completed": return { tone: "sent", text: "All messages sent, no reply" };
      case "stopped": return { tone: "stopped", text: "Stopped" };
      case "failed": return { tone: "failed", text: `Could not send${input.whatsappError ? `: ${input.whatsappError}` : ""}` };
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
