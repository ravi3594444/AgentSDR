"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { RiArrowLeftSLine, RiArrowRightSLine, RiCheckLine, RiCloseLine, RiContactsBook3Line, RiExpandDiagonalLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import { cn } from "@/utils/cn";
import { ContactAvatar } from "./ContactAvatar";
import { prefetchRecordWorkspace } from "./recordPrefetch";
import { hasUnsavedReply, useRecordQueue, type QueueItem } from "./recordQueue";

/** How long a handled lead stays on screen before the next one opens. */
const ADVANCE_DELAY_MS = 1600;
/** Cards drawn behind the pop-up, one per lead still waiting. */
const STACK_DEPTH = 3;

const recordHref = (id: string) => `/crm/records/${encodeURIComponent(id)}`;

/**
 * A lead's record as a large pop-up over the list it was opened from, so a
 * reply can be read, classified and sent without leaving the queue. Opened
 * by any in-app link to /crm/records/[id] (the intercepting route in
 * src/app/@modal/(.)crm/records); a direct load, reload or shared link
 * renders the full page instead.
 *
 * Opened from a list (Action required, Pipeline), it also steps through that
 * list: the arrows, J/K or ←/→ open the previous or next lead in place, and a
 * lead that leaves the queue once handled — a sent reply — hands over to the
 * next one by itself. The frame is the segment's layout above [id], so it
 * stays mounted while the record inside it changes.
 *
 * Closing (Esc, the overlay, the ✕) goes back in history, so the list below —
 * never unmounted — keeps its scroll, filters and loaded pages. Stepping
 * replaces the history entry rather than pushing, so one Back still closes.
 * Changes made in here reach that list through `announceRecordChanged`.
 *
 * "Open full page" is a plain anchor on purpose: a client-side navigation to
 * the same URL would be intercepted again and land back in this pop-up.
 */
export function CrmRecordModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const recordId = params.id ? decodeURIComponent(String(params.id)) : undefined;
  const contentRef = useRef<HTMLDivElement>(null);
  const nav = useQueueNavigation(recordId, contentRef);

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) router.back(); }}>
      <Modal.Content
        ref={contentRef}
        hideClose
        size="max-w-[1600px]"
        aria-describedby={undefined}
        // The visible card is the inner div, so the stack can sit behind it
        // inside the same dialog rather than over the page.
        className="h-[calc(100dvh-1rem)] max-h-none bg-transparent shadow-none ring-0 sm:h-[92dvh]"
      >
        <div className="relative flex h-full flex-col overflow-hidden rounded-2xl bg-bg-white-0 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-stroke-soft-200 pl-4 pr-2.5 sm:pl-5">
            <RiContactsBook3Line className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
            <Modal.Title className="min-w-0 flex-1 truncate text-label-sm text-text-sub-600">Lead record</Modal.Title>
            {nav && <QueueControls nav={nav} />}
            {/* A plain anchor: a hard navigation is the point (see above). */}
            {recordId && <Button.Root variant="neutral" mode="ghost" size="xsmall" asChild>
              <a href={recordHref(recordId)} title="Open this record as a full page">
                <Button.Icon as={RiExpandDiagonalLine} /><span className="hidden lg:inline">Open full page</span>
              </a>
            </Button.Root>}
            <Modal.Close asChild>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label="Close" title="Close (Esc)"><Button.Icon as={RiCloseLine} /></Button.Root>
            </Modal.Close>
          </div>
          <div data-record-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
            {children}
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

type QueueNav = NonNullable<ReturnType<typeof useQueueNavigation>>;

/**
 * Where this record sits in the list it was opened from, and how to move.
 *
 * Order comes from a trail: the list's ids as they were when the pop-up
 * opened, extended (never reordered) as more pages load. A handled lead drops
 * out of the live list but stays in the trail, so "next" is still the lead
 * that came after it rather than a jump back to the top. Leads that have
 * since left the list are skipped.
 */
function useQueueNavigation(recordId: string | undefined, contentRef: React.RefObject<HTMLDivElement | null>) {
  const router = useRouter();
  const queue = useRecordQueue();
  const [trail, setTrail] = useState<string[]>(() => queue?.items.map((item) => item.id) ?? []);
  useEffect(() => {
    if (!queue) return;
    setTrail((old) => {
      const seen = new Set(old);
      const added = queue.items.map((item) => item.id).filter((id) => !seen.has(id));
      return added.length ? [...old, ...added] : old;
    });
  }, [queue]);

  const derived = useMemo(() => {
    if (!queue || !recordId) return null;
    const index = trail.indexOf(recordId);
    if (index < 0) return null;
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    const ahead = trail.slice(index + 1).filter((id) => byId.has(id));
    const behind = trail.slice(0, index).filter((id) => byId.has(id));
    const position = queue.items.findIndex((item) => item.id === recordId);
    return {
      next: ahead[0] ?? null,
      prev: behind.at(-1) ?? null,
      upcoming: ahead.slice(0, STACK_DEPTH).map((id) => byId.get(id)!),
      remaining: ahead.length,
      // Not in the live list any more: it was handled while open.
      handled: position < 0,
      position: position + 1,
      total: queue.items.length,
      hasMore: queue.hasMore,
      loadMore: queue.loadMore,
    };
  }, [queue, recordId, trail]);

  const go = useCallback((id: string | null) => {
    if (!id || !recordId) return;
    if (hasUnsavedReply(recordId) && !window.confirm("You have an unsaved reply to this lead. Leave it and open the next one?")) return;
    router.replace(recordHref(id), { scroll: false });
  }, [recordId, router]);

  const next = derived?.next ?? null;
  const prev = derived?.prev ?? null;

  // Warm the next lead the moment it is known, the way hovering a row does.
  useEffect(() => {
    if (!next) return;
    router.prefetch(recordHref(next));
    prefetchRecordWorkspace(next);
  }, [next, router]);

  // Near the end of what is loaded, fetch the next page so stepping never
  // runs dry while the list still has more. Once per list length, since the
  // list keeps re-publishing while the page is in flight.
  const requestedAt = useRef(-1);
  const total = derived?.total ?? 0;
  const remaining = derived?.remaining ?? 0;
  const hasMore = derived?.hasMore ?? false;
  const loadMore = derived?.loadMore;
  useEffect(() => {
    if (!hasMore || !loadMore || remaining >= STACK_DEPTH || requestedAt.current === total) return;
    requestedAt.current = total;
    loadMore();
  }, [hasMore, loadMore, remaining, total]);

  // A lead handled while open moves on by itself, unless the reader asked to
  // stay or has typed something the move would lose.
  const [stayOn, setStayOn] = useState<string | null>(null);
  const handled = derived?.handled ?? false;
  const advancing = handled && Boolean(next) && stayOn !== recordId && !(recordId && hasUnsavedReply(recordId));
  useEffect(() => {
    if (!advancing) return;
    const timer = setTimeout(() => go(next), ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [advancing, go, next]);

  // J/K and ←/→, only while focus is in this pop-up (not in a dialog opened
  // over it) and not in a field or a widget that uses the arrows itself.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      const content = contentRef.current;
      if (!content || !target || !content.contains(target)) return;
      if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      const arrows = !target.closest("[role=tablist], [role=radiogroup], [role=listbox], [role=menu], [role=slider]");
      const key = event.key.toLowerCase();
      const forward = key === "j" || (arrows && key === "arrowright");
      const back = key === "k" || (arrows && key === "arrowleft");
      if (!forward && !back) return;
      event.preventDefault();
      go(forward ? next : prev);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contentRef, go, next, prev]);

  if (!derived) return null;
  return { ...derived, go, advancing, stay: () => setStayOn(recordId ?? null) };
}

function QueueControls({ nav }: { nav: QueueNav }) {
  const position = nav.handled
    ? nav.advancing ? "Done · opening next" : nav.next ? "Done" : nav.hasMore ? "Done · loading more" : "Queue cleared"
    : `${nav.position} of ${nav.total}${nav.hasMore ? "+" : ""}`;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {nav.upcoming.length > 0 && <UpNext items={nav.upcoming} onOpen={nav.go} />}
      <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label="Previous lead" title="Previous lead (K)" disabled={!nav.prev} onClick={() => nav.go(nav.prev)}>
        <Button.Icon as={RiArrowLeftSLine} />
      </Button.Root>
      <span role="status" className={cn("flex items-center gap-1 whitespace-nowrap px-0.5 text-label-xs tabular-nums", nav.handled ? "text-success-base" : "text-text-sub-600")}>
        {nav.handled && <RiCheckLine className="size-3.5" aria-hidden="true" />}
        {position}
      </span>
      {nav.advancing && <button type="button" onClick={nav.stay} className="rounded px-1 text-label-xs text-text-sub-600 underline-offset-2 hover:text-text-strong-950 hover:underline">Stay</button>}
      <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label="Next lead" title="Next lead (J)" disabled={!nav.next} onClick={() => nav.go(nav.next)}>
        <Button.Icon as={RiArrowRightSLine} />
      </Button.Root>
      <span className="mx-1 hidden h-4 w-px bg-stroke-soft-200 sm:block" aria-hidden="true" />
    </div>
  );
}

/** The next few leads as overlapping avatars; any one opens directly. */
function UpNext({ items, onOpen }: { items: QueueItem[]; onOpen: (id: string) => void }) {
  return (
    <div className="mr-1 hidden items-center gap-2 md:flex">
      <span className="text-paragraph-xs text-text-soft-400">Up next</span>
      <div className="flex -space-x-1.5">
        {items.map((item) => (
          <button key={item.id} type="button" onClick={() => onOpen(item.id)} title={`Open ${item.name}`} aria-label={`Open ${item.name}`} className="rounded-full ring-2 ring-bg-white-0 transition hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-stroke-strong-950">
            <ContactAvatar src={item.avatarUrl} fallback={initials(item.name)} className="size-6 bg-bg-weak-50 text-[12px] text-text-sub-600" />
          </button>
        ))}
      </div>
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}
