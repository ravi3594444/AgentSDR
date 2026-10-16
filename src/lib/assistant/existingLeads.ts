import type { LeadSignal } from "./schema";

/**
 * Pure parts of "use my existing leads or inquiries" (existingLeads.server.ts):
 * where a person came from in words, why they are on a list, and what an
 * inquiry contributes. An inquiry's message is the person's own words and
 * the only evidence of need it carries; nothing is inferred from it.
 */

export const EXISTING_LEADS_FROM = ["all", "latest_import", "inquiries"] as const;
export type ExistingLeadsFrom = (typeof EXISTING_LEADS_FROM)[number];

export function isExistingLeadsFrom(value: unknown): value is ExistingLeadsFrom {
  return typeof value === "string" && (EXISTING_LEADS_FROM as readonly string[]).includes(value);
}

const SOURCE_LABELS: [RegExp, string][] = [
  [/^discovery:google-maps$/, "Google Maps search"],
  [/^discovery:web-search$/, "web search"],
  [/^intake:website-form$/, "your website form"],
  [/^intake:instagram$/, "Instagram"],
  [/^manual-people-import$/, "an uploaded list"],
  [/linkedin/i, "LinkedIn"],
  [/whatsapp|calls?/i, "WhatsApp"],
  [/csv|xlsx|import|upload/i, "an uploaded list"],
];

/** "discovery:google-maps" → "Google Maps search"; unknown sources keep their name. */
export function peopleSourceLabel(source: string): string {
  for (const [pattern, label] of SOURCE_LABELS) if (pattern.test(source)) return label;
  return source.replace(/[_:-]+/g, " ").trim() || "your leads";
}

export function matchReasonForExisting(input: { createdAt: Date; sourceLabel: string; search: string | null }): string {
  const since = input.createdAt.toISOString().slice(0, 10);
  const base = `Already in your leads since ${since} (from ${input.sourceLabel})`;
  return input.search?.trim() ? `${base}; matches “${input.search.trim()}”.` : `${base}.`;
}

type InquiryLike = { source: "website_form" | "instagram"; message: string | null; pageUrl: string | null; at: Date };

/** What the writer may use: the inquiry, quoted and short, and where it came from. */
export function inquiryFacts(inquiry: InquiryLike): Record<string, string> {
  const facts: Record<string, string> = { inquiredVia: inquiry.source === "instagram" ? "Instagram" : "the website form" };
  const message = inquiry.message?.replace(/\s+/g, " ").trim();
  if (message) facts.inquiry = message.length > 300 ? `${message.slice(0, 299)}…` : message;
  return facts;
}

/** The inquiry as a signal: their words are a stated need; an empty form is no evidence of anything. */
export function inquirySignal(inquiry: InquiryLike): LeadSignal[] {
  const message = inquiry.message?.trim();
  if (!message) return [];
  return [{
    kind: "need",
    text: message.slice(0, 1_000),
    sourceUrl: inquiry.pageUrl,
    source: inquiry.source === "instagram" ? "Instagram message" : "website form",
    at: inquiry.at.toISOString(),
  }];
}
