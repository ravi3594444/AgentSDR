import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { CONNECTED_PAGE_TOOLS, groundingCorpus, ungroundedContacts } from "./agent";
import { quoteText } from "./agentV2.server";
import { ungroundedInstagramContacts } from "./instagramContacts";
import { assistantMessages, type ContactEvidence, type LeadSignal } from "./schema";

/** Tools whose successful result is a page the assistant read, and how the owner is told it was read. */
const PAGE_TOOLS: Record<string, string> = {
  read_webpage: "read on the web",
  browser_open: "read in the remote browser",
  browser_read: "read in the remote browser",
  browser_click: "read in the remote browser",
  browser_fill: "read in the remote browser",
  browser_scroll: "read in the remote browser",
  ...Object.fromEntries(CONNECTED_PAGE_TOOLS.map((tool) => [tool, "read in the owner's browser"])),
  // Exa page reads (codex/exa-discovery-20261027): several pages per result, in data.pages.
  exa_read: "read through Exa",
};

/** Where a lead was found: the page, when and how it was read, and the words on it that matter. */
export type PageEvidence = { sourceUrl: string; readAt: string; via: string; quote: string | null };

function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
    return left.hostname.replace(/^www\./, "") === right.hostname.replace(/^www\./, "") && path(left) === path(right) && left.search === right.search;
  } catch {
    return false;
  }
}

/** Who a lead is, as the model gives it: checked against the page it names, never against the whole chat. */
export type EvidenceIdentity = { contacts?: { email?: string | null; phone?: string | null; linkedinUrl?: string | null }[]; instagram?: string[] };

/** One page a successful read returned: where, when and how, its own text (for quotes) and what grounds a contact on it. */
type PageRead = { url: string; readAt: string; via: string; text: string; corpus: string };

type ReadRow = Pick<typeof assistantMessages.$inferSelect, "tool" | "content" | "toolResult" | "toolInput" | "createdAt">;

/**
 * The page's own text in a reading's summary, without the address, title,
 * links and elements around it: a browser reading puts it on its own
 * "Text…:" line, read_webpage after its links.
 */
function pageText(summary: string): string {
  const line = /\nText(?: \([^)]*\))?: /.exec(summary);
  if (line) return summary.slice(line.index + line[0].length);
  const links = summary.indexOf(" Links on the page: ");
  const start = links >= 0 ? summary.indexOf(" Text: ", links) : -1;
  return start >= 0 ? summary.slice(start + " Text: ".length) : "";
}

function readsOf(row: ReadRow): PageRead[] {
  const data = (row.toolResult?.data ?? {}) as { url?: unknown; readAt?: unknown; pages?: unknown };
  const via = PAGE_TOOLS[row.tool ?? ""] ?? "read";
  const when = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : row.createdAt.toISOString());
  if (Array.isArray(data.pages)) {
    return data.pages.flatMap((item) => {
      const page = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      if (typeof page.url !== "string" || typeof page.body !== "string") return [];
      let address = page.url;
      try {
        // The query and fragment are what the model asked with, not what the page published.
        const url = new URL(page.url);
        address = `${url.origin}${url.pathname}`;
      } catch { /* kept as given */ }
      const text = `${typeof page.title === "string" ? page.title : ""} ${page.body}`;
      return [{ url: page.url, readAt: when(page.readAt), via, text, corpus: `${address} ${text}` }];
    });
  }
  if (typeof data.url !== "string") return [];
  const summary = typeof row.toolResult?.summary === "string" ? row.toolResult.summary : row.content;
  return [{
    url: data.url,
    readAt: when(data.readAt),
    via,
    text: pageText(summary),
    // The same grounding the harness applies, for this one reading: what the model wrote into the address is not the page's.
    corpus: groundingCorpus([{ role: "tool", tool: row.tool, status: "ok", content: row.content, toolResult: row.toolResult, toolInput: row.toolInput }]),
  }];
}

/**
 * The page a lead came from, as this chat read it. `sourceUrl` must be a page
 * read here; `identity` (the lead's contacts, or Instagram handles) must
 * appear on that same reading, and `quote`, when given, in that reading's
 * own page text (not its address or the data around it). The newest reading
 * that backs all of it is the evidence; otherwise a problem for the model:
 * provenance is what the server read, never what the model says it read.
 */
export async function pageEvidence(threadId: string, sourceUrl: string, quote: string | null, identity: EvidenceIdentity = {}): Promise<PageEvidence | { problem: string }> {
  const rows = await db.select({ tool: assistantMessages.tool, content: assistantMessages.content, toolResult: assistantMessages.toolResult, toolInput: assistantMessages.toolInput, createdAt: assistantMessages.createdAt })
    .from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadId), eq(assistantMessages.role, "tool"), eq(assistantMessages.status, "ok"), inArray(assistantMessages.tool, Object.keys(PAGE_TOOLS))))
    .orderBy(desc(assistantMessages.createdAt)).limit(80);
  const reads = rows.flatMap(readsOf).filter((read) => samePage(read.url, sourceUrl));
  if (!reads.length) return { problem: `${sourceUrl} was not read in this chat; give the address of the page the contact was read on, as its reading shows it` };
  const missing = (read: PageRead) => [
    ...ungroundedContacts(identity.contacts ?? [], read.corpus),
    ...ungroundedInstagramContacts(identity.instagram ?? [], read.corpus).map((username) => `@${username}`),
  ];
  const identified = reads.filter((read) => !missing(read).length);
  if (!identified.length) return { problem: `${missing(reads[0]!).join(", ")} ${missing(reads[0]!).length === 1 ? "does" : "do"} not appear on ${sourceUrl} as it was read; give the page it was read on, or leave sourceUrl out` };
  const wanted = quote?.trim() ? quoteText(quote) : null;
  const read = wanted ? identified.find((item) => quoteText(item.text).includes(wanted)) : identified[0];
  if (!read) return { problem: `that quote is not in the text of ${sourceUrl} as it was read; quote it exactly, or leave quote out` };
  return { sourceUrl: read.url, readAt: read.readAt, via: read.via, quote: wanted ? quote!.trim().slice(0, 300) : null };
}

/** The evidence rows a found lead keeps: each contact with its page, and the quote as an observation (never as interest). */
export function evidenceRecords(evidence: PageEvidence, contacts: { kind: ContactEvidence["kind"]; value: string }[]): { evidence: ContactEvidence[]; signals: LeadSignal[] } {
  const host = (() => {
    try {
      return new URL(evidence.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return evidence.sourceUrl;
    }
  })();
  return {
    evidence: contacts.map((contact) => ({ kind: contact.kind, value: contact.value, sourceUrl: evidence.sourceUrl, source: `${host}, ${evidence.via}`, checkedAt: evidence.readAt })),
    signals: evidence.quote ? [{ kind: "observation", text: evidence.quote, sourceUrl: evidence.sourceUrl, source: `${host}, ${evidence.via}`, at: null, observedAt: evidence.readAt }] : [],
  };
}
