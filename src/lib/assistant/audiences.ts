import { isValidEmail } from "@/lib/email/recipients";
import { instagramUsername } from "@/lib/instagram/parse";
import type { AudienceChannel } from "./schema";

/**
 * Which channels can reach a lead, or why none can. Pure, shared by the
 * contact-list import and lead discovery, so both enter outreach on the same
 * rules: an email needs a valid address that is not unsubscribed or
 * bounced; WhatsApp a normalized (E.164) phone; LinkedIn a profile URL.
 * Do Not Contact excludes the lead from every channel.
 */
export type ContactFacts = {
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  instagramUsername?: string | null;
  doNotContact: boolean;
  /** On the email suppression list (unsubscribed, bounced, complaint, manual). */
  emailSuppressed: boolean;
};

export function contactChannels(facts: ContactFacts): { channels: AudienceChannel[]; reason: string | null } {
  if (facts.doNotContact) return { channels: [], reason: "marked Do Not Contact" };
  const channels: AudienceChannel[] = [];
  const notes: string[] = [];
  if (facts.email && isValidEmail(facts.email)) {
    if (facts.emailSuppressed) notes.push("email unsubscribed or bounced");
    else channels.push("email");
  }
  if (facts.phone && /^\+\d{7,15}$/.test(facts.phone)) channels.push("whatsapp");
  if (facts.linkedinUrl) channels.push("linkedin");
  if (instagramUsername(facts.instagramUsername)) channels.push("instagram");
  if (channels.length) return { channels, reason: null };
  return { channels, reason: notes[0] ?? "no email, phone, LinkedIn or Instagram profile" };
}

/** Exclusion reasons counted, largest first: "12 × no public email or phone". */
export function countReasons(reasons: readonly (string | null)[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
