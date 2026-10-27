"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RiMailLine, RiMoreLine, RiStarFill, RiStarLine } from "@remixicon/react";
import { EmptyState } from "@/components/page/EmptyState";
import { cn } from "@/utils/cn";
import { splitQuoted } from "@/lib/inbox/emailText";
export { splitQuoted } from "@/lib/inbox/emailText";
import type { EmailAddress, MessageRecipients } from "@/lib/email/recipients";
import { InboxAvatar, fullTime } from "./shell/InboxShell";

export type ThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  bodyText: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  sentAt: string | null;
  createdAt: string | null;
  important: boolean;
  /** Who the message was addressed to, from its own headers. */
  recipients?: MessageRecipients;
};

/** "A, B" using names where known; the full addresses go in the tooltip. */
export function formatAddresses(list: EmailAddress[]): { text: string; title: string } {
  return {
    text: list.map((a) => a.name || a.email).join(", "),
    title: list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", "),
  };
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isToday) return time;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

/** "Re: Fwd: Hello" → "Hello". */
export function threadSubject(subject: string | null | undefined): string {
  return (subject ?? "").replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
}

const LONG_BODY = 1400;

function MessageCard({
  message,
  leadName,
  leadEmail,
  defaultOpen,
  onToggleImportant,
}: {
  message: ThreadMessage;
  leadName: string;
  leadEmail?: string;
  defaultOpen: boolean;
  onToggleImportant: (id: string, next: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showQuoted, setShowQuoted] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const inbound = message.direction === "inbound";
  const senderName = inbound ? leadName : "You";
  const body = message.bodyText ?? "";
  const { main, quoted } = useMemo(() => splitQuoted(body), [body]);
  const preview = (main || body).replace(/\s+/g, " ").slice(0, 200);
  const long = main.length > LONG_BODY;
  const when = message.sentAt ?? message.createdAt;
  const toggle = () => setOpen((o) => !o);
  const recipient = inbound ? message.toEmail : message.toEmail ?? leadEmail;
  const to = message.recipients?.to ?? [];
  const cc = message.recipients?.cc ?? [];
  const bcc = inbound ? [] : message.recipients?.bcc ?? [];

  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl ring-1 ring-inset transition-shadow",
        open ? "shadow-regular-xs" : "",
        inbound ? "bg-bg-white-0 ring-stroke-soft-200" : "bg-bg-weak-50 ring-stroke-soft-200",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base"
      >
        <InboxAvatar name={inbound ? leadName : message.fromEmail || "You"} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-label-sm text-text-strong-950">{senderName}</span>
              {message.fromEmail && (
                <span className="hidden min-w-0 truncate text-paragraph-xs text-text-soft-400 sm:inline">{message.fromEmail}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <span className="text-paragraph-xs tabular-nums text-text-soft-400" title={fullTime(when ? new Date(when) : null)} suppressHydrationWarning>
                {formatTimestamp(when)}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleImportant(message.id, !message.important);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                aria-pressed={message.important}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md outline-none transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base",
                  message.important ? "text-warning-base" : "text-text-soft-400 hover:text-text-sub-600",
                )}
                title={message.important ? "Remove from important" : "Mark as important"}
                aria-label={message.important ? "Remove from important" : "Mark as important"}
              >
                {message.important ? <RiStarFill className="size-4" /> : <RiStarLine className="size-4" />}
              </button>
            </div>
          </div>
          {open ? (
            to.length > 0 || cc.length > 0 || bcc.length > 0 ? (
              <div className="text-paragraph-xs text-text-soft-400">
                {[
                  { label: "to", list: to },
                  { label: "cc", list: cc },
                  { label: "bcc", list: bcc },
                ]
                  .filter((part) => part.list.length > 0)
                  .map((part) => {
                    const { text, title } = formatAddresses(part.list);
                    return (
                      <p key={part.label} className="truncate" title={title}>
                        {part.label} {text}
                      </p>
                    );
                  })}
              </div>
            ) : (
              recipient && <p className="truncate text-paragraph-xs text-text-soft-400">to {recipient}</p>
            )
          ) : (
            <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">{preview || "(empty)"}</p>
          )}
        </div>
      </div>
      {open && (
        <div className="px-4 pb-4 sm:pl-15 sm:pr-6">
          <p className={cn("whitespace-pre-wrap wrap-break-word text-paragraph-sm leading-6 text-text-strong-950", long && !showAll && "line-clamp-[18]")}>
            {main || (quoted ? "" : "(empty)")}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              aria-expanded={showAll}
              className="mt-1.5 text-label-xs text-text-sub-600 underline-offset-2 outline-none hover:text-text-strong-950 hover:underline focus-visible:underline"
            >
              {showAll ? "Show less" : "Show the whole message"}
            </button>
          )}
          {quoted && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowQuoted((value) => !value)}
                aria-expanded={showQuoted}
                aria-label={showQuoted ? "Hide quoted text" : "Show quoted text"}
                title={showQuoted ? "Hide quoted text" : "Show quoted text"}
                className="inline-flex h-5 items-center rounded-md bg-bg-weak-50 px-1.5 text-text-sub-600 outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base"
              >
                <RiMoreLine className="size-4" aria-hidden="true" />
              </button>
              {showQuoted && (
                <p className="mt-2 whitespace-pre-wrap wrap-break-word border-l-2 border-stroke-soft-200 pl-3 text-paragraph-xs leading-5 text-text-sub-600">{quoted}</p>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * An email thread as a conversation: the subject once at the top, then one
 * card per message — the latest and the latest reply open, older ones folded
 * to a line, and a long run of older ones folded into "N earlier messages".
 * Quoted history hides behind "•••" and very long messages clamp.
 */
export default function EmailThread({
  messages,
  leadName,
  leadEmail,
  onToggleImportant,
}: {
  messages: ThreadMessage[];
  leadName: string;
  leadEmail?: string;
  onToggleImportant: (id: string, next: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const lastMessageId = messages[messages.length - 1]?.id;

  // Open at the top of the newest message, like a mail client — not at the
  // bottom of a long one. Only the thread's own scroller moves.
  useEffect(() => {
    const root = rootRef.current;
    const card = root?.querySelector<HTMLElement>(`[data-message-id="${lastMessageId}"]`);
    let scroller = root?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!card || !scroller) return;
    const top = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    // Already in the upper part of the view (a short thread): leave the subject in sight.
    if (top < scroller.clientHeight / 2) return;
    scroller.scrollTop = Math.max(0, top + scroller.scrollTop - 16);
  }, [lastMessageId]);

  if (messages.length === 0) {
    return <EmptyState icon={RiMailLine} title="No messages yet" description="Emails sent and received with this lead appear here." />;
  }

  const lastInboundId = [...messages].reverse().find((m) => m.direction === "inbound")?.id;
  const lastId = lastMessageId;
  const subject = threadSubject([...messages].reverse().find((m) => m.subject)?.subject) || "(no subject)";

  // Keep the first message and the last three; fold a longer middle.
  const foldFrom = 1;
  const foldTo = messages.length - 3;
  const folded = !showEarlier && foldTo - foldFrom >= 2 ? foldTo - foldFrom : 0;

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 text-label-lg text-text-strong-950 wrap-break-word">{subject}</h2>
        <span className="shrink-0 text-paragraph-xs tabular-nums text-text-soft-400">
          {messages.length} {messages.length === 1 ? "message" : "messages"}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {messages.map((m, index) => {
          if (folded && index >= foldFrom && index < foldTo) {
            if (index !== foldFrom) return null;
            return (
              <button
                key="folded"
                type="button"
                onClick={() => setShowEarlier(true)}
                className="relative my-1 flex items-center justify-center py-1 text-label-xs text-text-sub-600 outline-none before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-stroke-soft-200 hover:text-text-strong-950 focus-visible:underline"
              >
                <span className="relative rounded-full bg-bg-white-0 px-3 py-0.5 ring-1 ring-inset ring-stroke-soft-200">
                  {folded} earlier messages
                </span>
              </button>
            );
          }
          return (
            <div key={m.id} data-message-id={m.id}>
              <MessageCard
                message={m}
                leadName={leadName}
                leadEmail={leadEmail}
                defaultOpen={m.id === lastInboundId || m.id === lastId}
                onToggleImportant={onToggleImportant}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
