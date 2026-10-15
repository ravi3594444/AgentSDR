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
      // A list of places or customers ("Pune", "PCMC") is written as one line of text.
      const asText = typeof value === "string" ? value
        : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean).join(", ")
        : null;
      if (asText === null) {
        problems.push(`${key} must be text`);
        continue;
      }
      const text = asText.trim().slice(0, MAX_FIELD);
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

/** Fields of `patch` that would change the stored profile (a no-op save changes none). */
export function profileChanges(current: BusinessProfile, patch: Record<string, unknown>): string[] {
  const { profile } = mergeProfile(current, patch);
  return Object.keys(patch).filter((key) => {
    if (!(PROFILE_TEXT_FIELDS as readonly string[]).includes(key) && key !== "preferredChannels") return false;
    const field = key as keyof BusinessProfile;
    return JSON.stringify(current[field] ?? null) !== JSON.stringify(profile[field] ?? null);
  });
}

const GROUNDING_STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "your", "you", "are", "was", "who", "that", "this", "from", "into", "per", "all", "any",
  "can", "will", "also", "their", "they", "them", "its", "not", "but", "has", "have", "more", "most", "very", "such", "via",
  "within", "including", "across", "based", "offer", "offers", "provide", "provides", "providing", "business", "services",
]);

function significantWords(value: string): string[] {
  const words = value.toLowerCase().replace(/(\d),(?=\d)/g, "$1").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => (/\d/.test(word) || word.length >= 3) && !GROUNDING_STOPWORDS.has(word)))];
}

const stem = (word: string) => (/\d/.test(word) ? word : word.slice(0, 5));

/**
 * Text fields of `patch` whose words are mostly not in what the owner wrote
 * (`corpus`: their messages and the documents and lists they attached), so
 * the assistant saves the owner's information, not its own guesses. Words
 * match on their first five letters (service / servicing), numbers exactly;
 * at least 40% of a value's significant words must appear. An empty value
 * (clearing a field), the language code and channel choices are not checked.
 */
export function ungroundedProfileValues(patch: Record<string, unknown>, corpus: string): string[] {
  const known = new Set(significantWords(corpus).map(stem));
  const flat = corpus.toLowerCase().replace(/\s+/g, "");
  return Object.entries(patch).flatMap(([key, raw]) => {
    const value = Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw.join(", ") : raw;
    if (typeof value !== "string" || !value.trim() || key === "language") return [];
    if (!(PROFILE_TEXT_FIELDS as readonly string[]).includes(key)) return [];
    if (key === "website") {
      const host = value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
      return host && flat.includes(host) ? [] : [key];
    }
    const words = significantWords(value);
    if (!words.length) return [];
    const grounded = words.filter((word) => known.has(stem(word))).length;
    return grounded / words.length >= 0.4 ? [] : [key];
  });
}
