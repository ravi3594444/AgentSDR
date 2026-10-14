import type { BusinessProfile } from "./schema";

/**
 * The business profile the owner builds up in the chat: pure helpers to
 * merge what the assistant was told, decide what is still missing, and
 * write it as the knowledge document CRM drafts read.
 */

export const PROFILE_TEXT_FIELDS = [
  "businessName",
  "website",
  "offer",
  "targetCustomers",
  "locations",
  "outreachInstructions",
  "senderName",
  "senderRole",
  "bookingDetails",
  "language",
  "notes",
] as const satisfies readonly (keyof BusinessProfile)[];

export const PROFILE_LABELS: Record<(typeof PROFILE_TEXT_FIELDS)[number] | "preferredChannels", string> = {
  businessName: "Business",
  website: "Website",
  offer: "Offer",
  targetCustomers: "Target customers",
  locations: "Locations",
  outreachInstructions: "Outreach instructions",
  senderName: "Sender name",
  senderRole: "Sender role",
  bookingDetails: "How meetings are booked",
  language: "Language",
  notes: "Notes",
  preferredChannels: "Preferred channels",
};

const MAX_FIELD = 4_000;
const CHANNELS = new Set(["email", "whatsapp", "linkedin"]);

/**
 * `current` with `patch` applied: a text field replaces the old one, an
 * empty string clears it, a missing one is kept. Unknown keys and bad
 * values are reported, never stored.
 */
export function mergeProfile(current: BusinessProfile, patch: Record<string, unknown>): { profile: BusinessProfile; problems: string[] } {
  const profile: BusinessProfile = { ...current };
  const problems: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if ((PROFILE_TEXT_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== "string") {
        problems.push(`${key} must be text`);
        continue;
      }
      const text = value.trim().slice(0, MAX_FIELD);
      const field = key as (typeof PROFILE_TEXT_FIELDS)[number];
      if (!text) delete profile[field];
      else if (field === "language") {
        if (/^[a-z]{2}$/i.test(text)) profile.language = text.toLowerCase();
        else problems.push("language must be a two-letter code such as en");
      } else profile[field] = text;
    } else if (key === "preferredChannels") {
      if (!Array.isArray(value) || value.some((channel) => !CHANNELS.has(String(channel)))) {
        problems.push("preferredChannels must list email, whatsapp or linkedin");
        continue;
      }
      profile.preferredChannels = [...new Set(value.map(String))] as BusinessProfile["preferredChannels"];
    } else {
      problems.push(`${key} is not part of the business profile`);
    }
  }
  return { profile, problems };
}

/** What outreach cannot be written without; asked for before proposing a run. */
export function missingForOutreach(profile: BusinessProfile): string[] {
  const missing: string[] = [];
  if (!profile.businessName) missing.push("the business name");
  if (!profile.offer) missing.push("what you offer and why it helps");
  if (!profile.senderName) missing.push("the name messages are signed with");
  return missing;
}

/** What lead discovery cannot search without. */
export function missingForDiscovery(profile: BusinessProfile): string[] {
  const missing: string[] = [];
  if (!profile.targetCustomers) missing.push("who your customers are");
  if (!profile.locations) missing.push("where to look");
  return missing;
}

/** The profile as a knowledge document: one labelled line or paragraph per field. */
export function profileKnowledgeText(profile: BusinessProfile): string {
  const lines: string[] = [];
  for (const field of PROFILE_TEXT_FIELDS) {
    const value = profile[field];
    if (value) lines.push(`${PROFILE_LABELS[field]}: ${value}`);
  }
  if (profile.preferredChannels?.length) lines.push(`${PROFILE_LABELS.preferredChannels}: ${profile.preferredChannels.join(", ")}`);
  return lines.join("\n\n");
}
