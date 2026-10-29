"use client";

import { useState } from "react";
import { RiArrowRightSLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import { formatChatDate } from "@/lib/assistant/chatTime";
import { prospectsRequest, viewLeadsLabel } from "@/lib/assistant/leadLists";

/**
 * Every lead of a list before outreach: where and when it was found, why it
 * matched, how it can be reached (each detail with its page), only the
 * lead's own words as evidence of a need, and apart from them what its own
 * website showed (a possible fit, never interest). Loaded when opened, with
 * one GET (leadLists.ts prospectsRequest): opening it never prepares,
 * approves or sends anything.
 *
 * Shown under a search's card in the chat, under a finished search in a
 * request's summary (beside the chat and on the Requests page) and under the
 * request's final report. `count` is the list's contactable leads, the
 * figure the card and the report call contactable; `timeZone` is the
 * organization's, the zone every date here is written in (chatTime.ts).
 */

type ProspectSignal = {
  kind: "need" | "engagement" | "observation";
  text: string;
  sourceUrl: string | null;
  source: string;
  at: string | null;
  topic?: string;
  observedAt?: string;
  uncertainty?: string;
  relevance?: string | null;
  person?: { name: string; role: string; email: string | null; linkedin: string | null };
};
type ProspectView = {
  personId: string | null;
  name: string;
  status: "potential_match" | "inquired" | "replied" | "interested" | "excluded";
  statusLabel: string;
  excludedReason: string | null;
  source: { label: string; url: string | null };
  foundAt: string;
  matchReason: string;
  routes: { channel: string; value: string; sourceUrl: string | null; note: string }[];
  needEvidence: ProspectSignal[];
  engagement: ProspectSignal[];
  observations: ProspectSignal[];
  people: ProspectSignal[];
  website: { checkedAt: string; pages: string[]; notFound: string[] } | null;
  location: string;
  budget: string;
};
type ProspectsPayload = { counts: Record<string, number>; prospects: ProspectView[] };

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `Request failed (HTTP ${response.status})`);
  return parsed;
}

/** What the lead's own website showed, kept apart from need: each line with its page, and what the pages read did not show. */
function WebsiteFindings({ prospect, website, timeZone }: { prospect: ProspectView; website: NonNullable<ProspectView["website"]>; timeZone: string }) {
  const pages = `${website.pages.length} page${website.pages.length === 1 ? "" : "s"}`;
  return (
    <div className="mt-1 border-t border-stroke-soft-200 pt-1">
      <p className="text-text-soft-400">Their website, read {formatChatDate(website.checkedAt, timeZone)} ({pages}): a possible fit for your offer, not a sign they want to buy.</p>
      {prospect.observations.map((signal, index) => (
        <p key={`observation-${index}`} className="mt-0.5 break-words text-text-sub-600">
          {signal.text}{" "}
          <span className="text-text-soft-400">
            — {signal.sourceUrl ? <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{hostOf(signal.sourceUrl)}</a> : signal.source}
            {signal.relevance ? ` · ${signal.relevance}` : ""}{signal.uncertainty ? ` · ${signal.uncertainty}` : ""}
          </span>
        </p>
      ))}
      {prospect.people.length > 0 && (
        <p className="mt-0.5 break-words text-text-sub-600">
          Named on their website:{" "}
          {prospect.people.map((signal, index) => (
            <span key={`person-${index}`}>
              {index > 0 ? "; " : ""}
              {signal.sourceUrl ? <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary-base hover:underline">{signal.person?.name ?? signal.text}</a> : signal.person?.name ?? signal.text}
              {signal.person ? ` (${signal.person.role}${signal.person.email ? `, ${signal.person.email}` : ""})` : ""}
            </span>
          ))}
        </p>
      )}
      {website.notFound.length > 0 && <p className="mt-0.5 text-text-soft-400">Not found on the {pages} read (which does not mean it does not exist): {website.notFound.join(", ")}.</p>}
    </div>
  );
}

/** Leads listed before "Show all". */
const PROSPECTS_SHOWN = 10;

const PROSPECT_COLOR: Record<ProspectView["status"], "gray" | "green" | "blue" | "orange"> = { potential_match: "gray", inquired: "blue", replied: "orange", interested: "green", excluded: "gray" };

export function ProspectsList({ audienceId, count = null, excluded = null, title = null, timeZone }: {
  audienceId: string;
  /** The list's contactable leads; the control reads "View leads" without it. */
  count?: number | null;
  /** Leads found but left out (with their reasons, inside). */
  excluded?: number | null;
  /** Which search the list is, where several are shown together (the report). */
  title?: string | null;
  timeZone: string;
}) {
  const [data, setData] = useState<ProspectsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function load() {
    if (data || loading) return;
    setLoading(true);
    try {
      const { url, init } = prospectsRequest(audienceId);
      setData(await readJson<ProspectsPayload>(await fetch(url, init)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  // No scroll box inside the chat: the first ones, then the rest under Show all.
  const item = (prospect: ProspectView, index: number) => (
    <li key={`${prospect.personId ?? prospect.name}-${index}`} className="rounded-lg bg-bg-weak-50 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-label-xs text-text-strong-950">{prospect.name}</p>
        <Badge.Root variant="lighter" size="small" color={PROSPECT_COLOR[prospect.status]}>{prospect.statusLabel}</Badge.Root>
      </div>
      <p className="mt-0.5 text-text-sub-600">
        {prospect.source.url ? <a href={prospect.source.url} target="_blank" rel="noopener noreferrer" className="text-primary-base hover:underline">{prospect.source.label} ({hostOf(prospect.source.url)})</a> : prospect.source.label}
        {" · "}{formatChatDate(prospect.foundAt, timeZone)}
      </p>
      <p className="mt-0.5 text-text-sub-600">Why: {prospect.matchReason}</p>
      {prospect.excludedReason && <p className="mt-0.5 text-text-sub-600">Left out: {prospect.excludedReason}</p>}
      {prospect.routes.length > 0 ? prospect.routes.map((route) => (
        <p key={`${route.channel}:${route.value}`} className="mt-0.5 truncate text-text-sub-600">
          {route.channel}: {route.value} · {route.sourceUrl ? <a href={route.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary-base hover:underline">{route.note} ({hostOf(route.sourceUrl)})</a> : route.note}
        </p>
      )) : <p className="mt-0.5 text-text-sub-600">Contact: Unknown</p>}
      {prospect.needEvidence.map((signal, signalIndex) => (
        <p key={`need-${signalIndex}`} className="mt-0.5 border-l-2 border-stroke-sub-300 pl-2 text-text-sub-600">
          “{signal.text}” <span className="text-text-soft-400">— {signal.sourceUrl ? <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{signal.source}</a> : signal.source}{signal.at ? `, ${formatChatDate(signal.at, timeZone)}` : ""}</span>
        </p>
      ))}
      {prospect.engagement.length > 0 && <p className="mt-0.5 text-text-soft-400">{prospect.engagement.length} like{prospect.engagement.length === 1 ? "" : "s"}, follow{prospect.engagement.length === 1 ? "" : "s"} or generic comment{prospect.engagement.length === 1 ? "" : "s"} (not counted as interest)</p>}
      {!prospect.needEvidence.length && prospect.status === "potential_match" && <p className="mt-0.5 text-text-soft-400">No evidence of a need found.</p>}
      {prospect.website && <WebsiteFindings prospect={prospect} website={prospect.website} timeZone={timeZone} />}
      <p className="mt-0.5 text-text-soft-400">Location: {prospect.location} · Budget: {prospect.budget}</p>
    </li>
  );
  const counts = data?.counts;
  const note = [title, "source, why they match, evidence", excluded ? `${excluded} left out` : null].filter(Boolean).join(" · ");
  return (
    <details className="group text-paragraph-xs" onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void load(); }}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-base [&::-webkit-details-marker]:hidden">
        <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-bg-white-0 pl-1.5 pr-2.5 text-label-xs text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 transition-colors group-hover:bg-bg-weak-50">
          <RiArrowRightSLine className="size-4 shrink-0 text-text-soft-400 transition-transform group-open:rotate-90" aria-hidden="true" />
          {viewLeadsLabel(count)}
        </span>
        <span className="min-w-0 text-text-soft-400 [overflow-wrap:anywhere]">{note}</span>
      </summary>
      {loading && <p className="mt-1.5 text-text-soft-400">Loading…</p>}
      {error && <p role="alert" className="mt-1.5 text-error-base">{error}</p>}
      {counts && (
        <p className="mt-1.5 text-text-sub-600">
          {counts.potential_match ?? 0} potential match{counts.potential_match === 1 ? "" : "es"} · {counts.inquired ?? 0} inquired · {counts.replied ?? 0} Replied · {counts.interested ?? 0} Interested · {counts.withNeedEvidence ?? 0} with their own words showing a need. A potential match is not an interested customer.
        </p>
      )}
      {data && (
        <ul className="mt-1.5 space-y-1.5">
          {data.prospects.slice(0, PROSPECTS_SHOWN).map(item)}
        </ul>
      )}
      {data && data.prospects.length > PROSPECTS_SHOWN && (
        <details className="group/more mt-1.5">
          <summary className="inline-flex min-h-9 cursor-pointer list-none items-center rounded-md text-label-xs text-primary-base outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base [&::-webkit-details-marker]:hidden">
            <span className="group-open/more:hidden">Show all {data.prospects.length}</span><span className="hidden group-open/more:inline">Showing all {data.prospects.length}</span>
          </summary>
          <ul className="mt-1.5 space-y-1.5">{data.prospects.slice(PROSPECTS_SHOWN).map((prospect, index) => item(prospect, index + PROSPECTS_SHOWN))}</ul>
        </details>
      )}
    </details>
  );
}
