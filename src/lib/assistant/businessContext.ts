import { missingForDiscovery, missingForOutreach } from "./profile";
import type { BusinessProfile } from "./schema";

/**
 * Everything the organization has already told AgentSDR about its business,
 * wherever it was saved: the assistant's business profile, the knowledge
 * documents (a brochure, a price list), the names the connected accounts
 * send as, and the reply instructions in Settings → Instructions. The
 * assistant reads this before asking anything, so it asks only for what is
 * genuinely missing, and it reuses a sender name an account already carries
 * instead of asking for it again. Pure; the reads are in
 * businessContext.server.ts.
 */

export type SavedDocument = { title: string; kind: string };
export type SenderIdentity = { name: string; source: "mailbox" | "LinkedIn" | "WhatsApp" | "Instagram" };

export type BusinessSources = {
  documents: SavedDocument[];
  senders: SenderIdentity[];
  /** Titles of the reply-drafting instructions saved in Settings → Instructions. */
  instructions: string[];
};

export type BusinessContext = {
  /** What lead discovery still needs (profile fields, which documents may hold). */
  missingForDiscovery: string[];
  /** What outreach still needs, after reusing a known sender name. */
  missingForOutreach: string[];
  /** Worth asking once, never blocking: prices when no price list or prices are saved. */
  optional: string[];
  /** The name messages are signed with: the profile's, else the one every connected account uses. */
  sender: { name: string; source: string } | null;
  /** Documents that look like price lists or rates. */
  priceDocuments: string[];
  /** One line for the assistant's context. */
  summary: string;
};

const PRICE_TITLE = /\b(?:price|prices|pricing|rate|rates|fee|fees|tariff|menu|quote|quotation|packages?|plans?)\b/i;

/** Documents that plausibly hold prices: saved as "pricing", or titled like a price list. */
export function priceDocuments(documents: readonly SavedDocument[]): string[] {
  return documents.filter((document) => document.kind === "pricing" || PRICE_TITLE.test(document.title)).map((document) => document.title);
}

/**
 * Whether an account's label reads as a person's or business's name: not an
 * email address, not a phone number or handle full of digits. Unipile
 * mailboxes often carry the address as their name, WhatsApp accounts the
 * number — neither may sign a message.
 */
export function looksLikeSenderName(name: string): boolean {
  const value = name.trim();
  if (!value || value.length > 60 || value.includes("@") || /^https?:/i.test(value)) return false;
  if ((value.match(/\d/g) ?? []).length >= 3) return false;
  return /\p{L}{2,}/u.test(value);
}

/**
 * The sender name to reuse when the profile has none: only when every
 * connected account whose label reads as a name (looksLikeSenderName) uses
 * the same one (case-insensitive), so nothing is guessed when a mailbox and
 * a LinkedIn profile disagree, and no address or number signs a message.
 */
export function reusableSender(senders: readonly SenderIdentity[]): SenderIdentity | null {
  const named = senders.filter((sender) => looksLikeSenderName(sender.name));
  if (!named.length) return null;
  const distinct = new Set(named.map((sender) => sender.name.trim().toLowerCase()));
  return distinct.size === 1 ? { name: named[0]!.name.trim(), source: named[0]!.source } : null;
}

const USER_DOCUMENT = (document: SavedDocument) => !/^Business profile \(from the assistant\)$/.test(document.title) && document.title !== "Answers you gave the assistant";

export function businessContext(profile: BusinessProfile, sources: BusinessSources): BusinessContext {
  const fromAccounts = profile.senderName?.trim() ? null : reusableSender(sources.senders);
  const sender = profile.senderName?.trim()
    ? { name: profile.senderName.trim(), source: "your business profile" }
    : fromAccounts ? { name: fromAccounts.name, source: `your ${fromAccounts.source} account` } : null;
  const effective: BusinessProfile = sender ? { ...profile, senderName: sender.name } : profile;
  const userDocuments = sources.documents.filter(USER_DOCUMENT);
  const documentHint = userDocuments.length ? ` (read the saved documents with search_knowledge first: ${userDocuments.slice(0, 6).map((document) => `“${document.title}”`).join(", ")})` : "";
  const discovery = missingForDiscovery(effective).map((item) => `${item}${documentHint}`);
  const outreach = missingForOutreach(effective).map((item) => {
    if (item === "the name messages are signed with" && sources.senders.length > 1) {
      return `${item} (your accounts send as ${[...new Set(sources.senders.map((s) => s.name))].join(", ")}: ask which one)`;
    }
    return item === "the name messages are signed with" ? item : `${item}${documentHint}`;
  });
  const prices = priceDocuments(userDocuments);
  const savedPrices = profile.prices?.trim() ?? "";
  const optional = !prices.length && !savedPrices && !/\d/.test(`${profile.offer ?? ""} ${profile.notes ?? ""}`) ? ["prices (ask once if leads are likely to ask; never block on it)"] : [];
  const priceSources = [...(savedPrices ? ["the business profile"] : []), ...prices.map((title) => `“${title}”`)];
  const summary = [
    `documents: ${userDocuments.length ? userDocuments.map((document) => `“${document.title}” (${document.kind})`).join(", ") : "none"}`,
    `prices: ${priceSources.length ? `in ${priceSources.join(", ")}` : "none saved"}`,
    `sender: ${sender ? `${sender.name} (from ${sender.source})` : sources.senders.length ? `accounts send as ${[...new Set(sources.senders.map((s) => `${s.name} (${s.source})`))].join(", ")}` : "unknown"}`,
    `reply instructions: ${sources.instructions.length ? sources.instructions.map((title) => `“${title}”`).join(", ") : "none"}`,
  ].join("; ");
  return { missingForDiscovery: discovery, missingForOutreach: outreach, optional, sender, priceDocuments: prices, summary };
}
