import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { CONNECTED_PAGE_TOOLS } from "./agent";
import { quoteText } from "./agentV2.server";
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

/**
 * The page a lead came from, as this chat read it: `sourceUrl` must be a
 * page read here (its latest reading), and `quote`, when given, must be on
 * it. A problem for the model otherwise: provenance is what the server read,
 * never what the model says it read.
 */
export async function pageEvidence(threadId: string, sourceUrl: string, quote: string | null): Promise<PageEvidence | { problem: string }> {
  const reads = await db.select({ tool: assistantMessages.tool, content: assistantMessages.content, toolResult: assistantMessages.toolResult, createdAt: assistantMessages.createdAt })
    .from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadId), eq(assistantMessages.role, "tool"), eq(assistantMessages.status, "ok"), inArray(assistantMessages.tool, Object.keys(PAGE_TOOLS))))
    .orderBy(desc(assistantMessages.createdAt)).limit(80);
  const pages = reads.filter((row) => {
    const url = (row.toolResult?.data as { url?: unknown } | undefined)?.url;
    return typeof url === "string" && samePage(url, sourceUrl);
  });
  if (!pages.length) return { problem: `${sourceUrl} was not read in this chat; give the address of the page the contact was read on, as its reading shows it` };
  const wanted = quote?.trim() ? quoteText(quote) : null;
  const page = wanted ? pages.find((row) => quoteText(`${row.content} ${JSON.stringify(row.toolResult ?? {})}`).includes(wanted)) : pages[0];
  if (!page) return { problem: `that quote is not on ${sourceUrl} as it was read; quote it exactly, or leave quote out` };
  const data = (page.toolResult?.data ?? {}) as { url?: string; readAt?: unknown };
  const readAt = typeof data.readAt === "string" && Number.isFinite(Date.parse(data.readAt)) ? data.readAt : page.createdAt.toISOString();
  return { sourceUrl: data.url ?? sourceUrl, readAt, via: PAGE_TOOLS[page.tool ?? ""] ?? "read", quote: wanted ? quote!.trim().slice(0, 300) : null };
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
