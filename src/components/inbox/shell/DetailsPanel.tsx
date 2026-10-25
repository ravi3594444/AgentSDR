"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import {
  RiBuilding2Line,
  RiCloseLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiLinkedinBoxLine,
  RiMailLine,
  RiPhoneLine,
  RiUserSearchLine,
} from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { CompanyFavicon } from "@/components/calling/callingShared";
import { asObject, categoryColor, crmFetch } from "@/components/crm/crm-utils";
import { Skeleton } from "@/components/page/Skeletons";
import { cn } from "@/utils/cn";
import { ChannelTag, InboxAvatar, fullTime, type InboxChannel } from "./InboxShell";

/**
 * The right-hand column of an inbox: who the person is and where they stand.
 *
 * Pinned beside the thread from 1400 px (list + thread + details fit side by
 * side there); below that it is an overlay the thread header toggles, closed
 * again whenever another conversation opens. The pinned state is remembered
 * per browser.
 */

const WIDE_QUERY = "(min-width: 1400px)";
const STORAGE_KEY = "agentsdr-inbox-details";

function subscribe(query: string) {
  return (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
}

export function useMediaQuery(query: string): boolean {
  const onSubscribe = useMemo(() => subscribe(query), [query]);
  return useSyncExternalStore(
    onSubscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Open/closed state of the details column for the conversation `key`.
 * Wide: closed until opened, with an existing saved choice kept. Narrow: an overlay, closed by
 * default and on every conversation change.
 */
export function useDetailsPanel(key: string | null) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [pinned, setPinned] = useState(false);
  const [overlayFor, setOverlayFor] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only preference, read after hydration
    setPinned(readPinned());
  }, []);

  const open = key !== null && (wide ? pinned : overlayFor === key);

  const setOpen = useCallback(
    (next: boolean) => {
      if (wide) {
        setPinned(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        } catch {
          /* storage blocked: the choice lasts for this page only */
        }
      } else {
        setOverlayFor(next ? key : null);
      }
    },
    [wide, key],
  );

  return { open, wide, setOpen, toggle: () => setOpen(!open) };
}

/** The column itself: a titled, scrolling aside; an overlay with a scrim below 1400 px. */
export function DetailsPanel({ open, wide, onClose, children }: { open: boolean; wide: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !wide) {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <>
      {!wide && <div aria-hidden="true" onClick={onClose} className="absolute inset-0 z-20 bg-bg-strong-950/10 backdrop-blur-[1px]" />}
      <aside
        aria-label="Contact details"
        onKeyDown={onKeyDown}
        className={cn(
          "flex flex-col bg-bg-white-0",
          wide ? "w-72 shrink-0 border-l border-stroke-soft-200" : "absolute inset-y-0 right-0 z-30 w-full max-w-[22rem] border-l border-stroke-soft-200 shadow-regular-md",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-stroke-soft-200 pl-5 pr-3">
          <h2 className="text-label-sm text-text-strong-950">Details</h2>
          <Button.Root variant="neutral" mode="ghost" size="xxsmall" onClick={onClose} aria-label="Close details" title="Close details" autoFocus={!wide}>
            <Button.Icon as={RiCloseLine} />
          </Button.Root>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------- content

export type DetailsFact = { label: string; value: ReactNode; title?: string };

export type DetailsCrm = {
  recordId: string | null;
  categoryKey: string | null;
  categoryLabel: string;
  stage?: string | null;
  sequence?: string | null;
  step?: string | null;
  nextActionAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  doNotContact?: boolean;
};

/**
 * The details column's content: the person card with quick links, their CRM
 * standing, this conversation's facts, and how to reach them.
 */
export function ContactDetails({
  name,
  avatarSrc,
  headline,
  company,
  channel,
  links,
  crm,
  crmLoading,
  facts = [],
  actions,
}: {
  name: string;
  avatarSrc?: string | null;
  headline?: string | null;
  company?: { name: string | null; domain?: string | null } | null;
  channel: InboxChannel;
  links: { recordId?: string | null; linkedinUrl?: string | null; email?: string | null; phone?: string | null };
  crm?: DetailsCrm | null;
  crmLoading?: boolean;
  facts?: DetailsFact[];
  /** Extra actions under the quick links (Call). */
  actions?: ReactNode;
}) {
  const linkedinHref = links.linkedinUrl ? toLinkedinHref(links.linkedinUrl) : null;
  return (
    <div className="divide-y divide-stroke-soft-200">
      <section className="px-5 py-5">
        <InboxAvatar name={name} src={avatarSrc} size="lg" />
        <p className="mt-3 text-label-md text-text-strong-950 wrap-break-word">{name}</p>
        {headline && <p className="mt-0.5 line-clamp-2 text-paragraph-xs text-text-sub-600" title={headline}>{headline}</p>}
        {company?.name && (
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-paragraph-xs text-text-sub-600">
            {company.domain ? <CompanyFavicon domain={company.domain} /> : <RiBuilding2Line className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />}
            <span className="truncate" title={company.domain ?? company.name}>{company.name}</span>
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {links.recordId && (
            <Button.Root variant="neutral" mode="stroke" size="xxsmall" asChild>
              <Link href={`/crm/records/${links.recordId}`}>
                <Button.Icon as={RiUserSearchLine} />
                CRM record
              </Link>
            </Button.Root>
          )}
          {linkedinHref && <QuickLink href={linkedinHref} icon={RiLinkedinBoxLine} label="LinkedIn profile" external />}
          {links.email && <QuickLink href={`mailto:${links.email}`} icon={RiMailLine} label={`Email ${links.email}`} />}
          {links.phone && <QuickLink href={`tel:${links.phone}`} icon={RiPhoneLine} label={`Phone ${links.phone}`} />}
          {actions}
        </div>
      </section>

      {(crm || crmLoading) && (
        <section className="px-5 py-4">
          <SectionTitle>CRM</SectionTitle>
          {crm ? (
            <>
              {crm.doNotContact && (
                <p className="mb-3 flex items-start gap-1.5 rounded-lg bg-error-lighter px-2.5 py-2 text-paragraph-xs text-error-dark ring-1 ring-inset ring-error-light">
                  <RiErrorWarningLine className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                  Do not contact — this lead opted out.
                </p>
              )}
              <dl className="space-y-2.5">
                <Fact label="Category">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: categoryColor(crm.categoryKey).color }} />
                    <span className="truncate">{crm.categoryLabel}</span>
                  </span>
                </Fact>
                {crm.stage && <Fact label="Stage">{crm.stage}</Fact>}
                {crm.sequence && <Fact label="Sequence">{crm.sequence}</Fact>}
                {crm.step && <Fact label="Next step">{crm.step}</Fact>}
                {crm.nextActionAt && <Fact label="Next action"><When iso={crm.nextActionAt} /></Fact>}
                {crm.lastInboundAt && <Fact label="Last reply"><When iso={crm.lastInboundAt} /></Fact>}
                {crm.lastOutboundAt && <Fact label="Last sent"><When iso={crm.lastOutboundAt} /></Fact>}
              </dl>
            </>
          ) : (
            <div className="space-y-2.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          )}
        </section>
      )}

      <section className="px-5 py-4">
        <SectionTitle>Conversation</SectionTitle>
        <dl className="space-y-2.5">
          <Fact label="Channel">
            <ChannelTag channel={channel} />
          </Fact>
          {facts.map((fact) => (
            <Fact key={fact.label} label={fact.label} title={fact.title}>
              {fact.value}
            </Fact>
          ))}
        </dl>
      </section>

      {(links.email || links.phone || linkedinHref) && (
        <section className="px-5 py-4">
          <SectionTitle>Contact</SectionTitle>
          <dl className="space-y-2.5">
            {links.email && (
              <Fact label="Email" title={links.email}>
                <a href={`mailto:${links.email}`} className="truncate text-text-strong-950 underline-offset-2 hover:underline">{links.email}</a>
              </Fact>
            )}
            {links.phone && (
              <Fact label="Phone">
                <a href={`tel:${links.phone}`} className="tabular-nums text-text-strong-950 underline-offset-2 hover:underline">{links.phone}</a>
              </Fact>
            )}
            {linkedinHref && (
              <Fact label="LinkedIn">
                <a href={linkedinHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-text-strong-950 underline-offset-2 hover:underline">
                  <span className="truncate">{linkedinHandle(linkedinHref)}</span>
                  <RiExternalLinkLine className="size-3 shrink-0 text-text-soft-400" aria-hidden="true" />
                </a>
              </Fact>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-subheading-2xs uppercase text-text-soft-400">{children}</h3>;
}

function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-2 text-paragraph-xs">
      <dt className="text-text-soft-400">{label}</dt>
      <dd className="flex min-w-0 text-text-strong-950" title={title}>
        <span className="min-w-0 truncate">{children}</span>
      </dd>
    </div>
  );
}

function When({ iso }: { iso: string }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>—</>;
  return (
    <span title={fullTime(date)} suppressHydrationWarning>
      {relativeWhen(date)}
    </span>
  );
}

function QuickLink({ href, icon: Icon, label, external }: { href: string; icon: ComponentType<{ className?: string }>; label: string; external?: boolean }) {
  return (
    <Button.Root variant="neutral" mode="stroke" size="xxsmall" asChild className="w-7 px-0">
      <a href={href} aria-label={label} title={label} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        <Button.Icon as={Icon} />
      </a>
    </Button.Root>
  );
}

/** "in 3h", "2d ago", "just now" — with the full stamp in the tooltip. */
export function relativeWhen(date: Date, now = Date.now()): string {
  const delta = date.getTime() - now;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return "just now";
  const unit = minutes < 60 ? `${minutes}m` : minutes < 60 * 24 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (60 * 24))}d`;
  return delta > 0 ? `in ${unit}` : `${unit} ago`;
}

export function toLinkedinHref(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes("linkedin.com")) return `https://${value.replace(/^\/+/, "")}`;
  return `https://www.linkedin.com/in/${value.replace(/^\/+|\/+$/g, "")}`;
}

function linkedinHandle(href: string): string {
  return href.replace(/^https?:\/\/(www\.)?linkedin\.com\//i, "").replace(/\/+$/, "") || href;
}

const WORKFLOW_LABEL: Record<string, string> = {
  unclassified: "Unclassified",
  classifying: "Classifying",
  action_required: "Action required",
  waiting: "Waiting",
  idle: "Idle",
  paused: "Paused",
  closed: "Closed",
  error: "Needs attention",
};

export function workflowLabel(state: string | null | undefined): string | null {
  if (!state) return null;
  return WORKFLOW_LABEL[state] ?? state.replace(/_/g, " ");
}

// ---------------------------------------------------------------- CRM record

/** What the details column reads from a CRM record (GET /api/crm/records/:id). */
export type CrmRecordSummary = {
  recordId: string;
  personId: string | null;
  fullName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  profilePictureUrl: string | null;
  company: { name: string | null; domain: string | null } | null;
  categoryKey: string | null;
  subcategory: string | null;
  workflowState: string | null;
  sequence: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  nextActionAt: string | null;
  doNotContact: boolean;
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function toSummary(recordId: string, raw: unknown): CrmRecordSummary {
  const record = asObject(raw);
  const person = asObject(record.person);
  const company = asObject(record.company);
  const runs = Array.isArray(record.runs) ? record.runs.map(asObject) : [];
  const activeRun = runs.find((entry) => asObject(entry.run).status === "active") ?? runs[0];
  const fullName = str(person.fullName) ?? ([str(person.firstName), str(person.lastName)].filter(Boolean).join(" ") || null);
  return {
    recordId,
    personId: str(person.id),
    fullName,
    title: str(person.title),
    email: str(person.email),
    phone: str(person.phone),
    linkedinUrl: str(person.linkedinUrl),
    profilePictureUrl: str(person.profilePictureUrl),
    company: str(company.name) || str(company.domain) ? { name: str(company.name) ?? str(person.company), domain: str(company.domain) } : str(person.company) ? { name: str(person.company), domain: null } : null,
    categoryKey: str(record.categoryKey),
    subcategory: str(record.subcategory),
    workflowState: str(record.workflowState),
    sequence: activeRun ? str(asObject(activeRun.sequence).name) : null,
    lastInboundAt: str(record.lastInboundAt),
    lastOutboundAt: str(record.lastOutboundAt),
    nextActionAt: str(record.nextActionAt),
    doNotContact: record.dnc === true,
  };
}

/** Records read in this tab, briefly cached so flicking between threads does not refetch. */
const recordCache = new Map<string, { at: number; value: Promise<CrmRecordSummary> }>();
const RECORD_TTL_MS = 60_000;

function loadRecord(recordId: string): Promise<CrmRecordSummary> {
  const cached = recordCache.get(recordId);
  if (cached && Date.now() - cached.at < RECORD_TTL_MS) return cached.value;
  const value = crmFetch(`/records/${recordId}`).then((raw) => toSummary(recordId, raw));
  value.catch(() => recordCache.delete(recordId));
  recordCache.set(recordId, { at: Date.now(), value });
  return value;
}

/**
 * The CRM record behind a conversation, read-only. Fetched only while
 * `enabled` (the details column is open, or a header needs the category), so
 * an inbox does not load a record per thread nobody looks at.
 */
export function useCrmRecordSummary(recordId: string | null | undefined, enabled = true): { summary: CrmRecordSummary | null; loading: boolean } {
  const [state, setState] = useState<{ id: string; summary: CrmRecordSummary | null; done: boolean } | null>(null);
  useEffect(() => {
    if (!recordId || !enabled) return;
    let active = true;
    loadRecord(recordId)
      .then((summary) => {
        if (active) setState({ id: recordId, summary, done: true });
      })
      .catch(() => {
        if (active) setState({ id: recordId, summary: null, done: true });
      });
    return () => {
      active = false;
    };
  }, [recordId, enabled]);
  const current = state && state.id === recordId ? state : null;
  return { summary: current?.summary ?? null, loading: Boolean(recordId && enabled && !current?.done) };
}
