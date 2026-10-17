"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { RiLoader4Line, RiSendPlane2Fill } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { cn } from "@/utils/cn";
import { Kbd, dayHeading } from "./InboxShell";

/**
 * The pieces a chat-style thread (LinkedIn, WhatsApp) is drawn from, and the
 * composer both use. Neutral surfaces keep the message readable in both
 * themes; alignment, grouped corners and captions show who is speaking.
 */

/** A centred date between messages ("Today", "Mon, Sep 12"). */
export function DaySeparator({ date }: { date: Date }) {
  return (
    <div className="my-5 flex items-center gap-3 first:mt-1" role="separator" aria-label={dayHeading(date)}>
      <span className="h-px flex-1 bg-stroke-soft-200" />
      <span className="rounded-full bg-bg-weak-50 px-3 py-1 text-[11px] font-medium text-text-sub-600" suppressHydrationWarning>
        {dayHeading(date)}
      </span>
      <span className="h-px flex-1 bg-stroke-soft-200" />
    </div>
  );
}

/** Who wrote a run of messages, how it was sent, and when — above the run's first bubble. */
export function MessageCaption({ outbound, who, detail, time, timeTitle }: { outbound: boolean; who: ReactNode; detail?: ReactNode; time?: string; timeTitle?: string }) {
  return (
    <div className={cn("mb-1 flex items-baseline gap-1.5 px-1 text-paragraph-xs", outbound ? "justify-end" : "justify-start")}>
      <span className="text-label-xs text-text-strong-950">{who}</span>
      {detail && <span className="text-text-soft-400">· {detail}</span>}
      {time && (
        <span className="tabular-nums text-text-soft-400" title={timeTitle} suppressHydrationWarning>
          {time}
        </span>
      )}
    </div>
  );
}

/**
 * One message. `first`/`last` shape the corners of a run so consecutive
 * messages read as one block; `footer` is the in-bubble time and ticks.
 */
export function Bubble({
  outbound,
  first = true,
  last = true,
  title,
  footer,
  className,
  children,
}: {
  outbound: boolean;
  first?: boolean;
  last?: boolean;
  title?: string;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      title={title}
      className={cn(
        "max-w-[min(40rem,90%)] px-4 py-3 text-paragraph-sm leading-6 text-text-strong-950 [overflow-wrap:anywhere] sm:max-w-[min(40rem,85%)]",
        outbound ? "bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200" : "bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200",
        "rounded-2xl",
        outbound ? [!first && "rounded-tr-md", !last && "rounded-br-md"] : [!first && "rounded-tl-md", !last && "rounded-bl-md"],
        className,
      )}
    >
      {children}
      {footer && <div className="mt-1.5 flex items-center justify-end gap-1 text-[11px] leading-4 text-text-soft-400">{footer}</div>}
    </div>
  );
}

/** Rough "is this long" test: characters, or lines for short-lined text. */
export function isLongText(text: string, maxChars = 480, maxLines = 9): boolean {
  return text.length > maxChars || text.split("\n").length > maxLines;
}

/**
 * Text that clamps to a few lines with "Show more" when long. `collapsed`
 * sets the starting state; short text never clamps.
 */
export function ExpandableText({ text, collapsed = true, lines = 6, className }: { text: string; collapsed?: boolean; lines?: 4 | 6 | 10; className?: string }) {
  const long = isLongText(text);
  const [open, setOpen] = useState(!collapsed || !long);
  const clamp = { 4: "line-clamp-4", 6: "line-clamp-6", 10: "line-clamp-10" }[lines];
  return (
    <div className={className}>
      <p className={cn("whitespace-pre-wrap wrap-break-word", !open && clamp)}>{text}</p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-1 text-label-xs text-text-sub-600 underline-offset-2 outline-none hover:text-text-strong-950 hover:underline focus-visible:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * Keeps a scroller pinned to the newest message: jumps to the bottom when a
 * different thread opens, and follows new messages only while the reader is
 * already near the bottom (so polling never yanks them out of history).
 */
export function useStickToBottom(threadKey: string | null, count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const lastKey = useRef<string | null>(null);
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const switched = lastKey.current !== threadKey;
    const grew = count > lastCount.current;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 200;
    if (switched || lastCount.current === 0 || (grew && nearBottom)) element.scrollTop = element.scrollHeight;
    lastKey.current = threadKey;
    lastCount.current = count;
  }, [threadKey, count]);
  return ref;
}

/**
 * The chat composer: a growing text box, a meta line (channel, who it is
 * sent as), the shortcut hint and Send. Enter sends, Shift+Enter breaks the
 * line. `banner` sits inside the box above the text — the AI-draft notice.
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  sending = false,
  disabled = false,
  placeholder = "Write a message…",
  ariaLabel = "Message",
  meta,
  banner,
  submitLabel = "Send",
  textareaRef,
  tone = "default",
  minRows = 1,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  meta?: ReactNode;
  banner?: ReactNode;
  submitLabel?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** `draft` tints the frame while an AI draft is in the box. */
  tone?: "default" | "draft";
  minRows?: number;
  className?: string;
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const innerRef = textareaRef ?? ownRef;

  // Grow with the text up to a cap, then scroll inside.
  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [value, innerRef]);

  const canSend = !disabled && !sending && value.trim().length > 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl bg-bg-white-0 ring-1 ring-inset transition focus-within:ring-stroke-strong-950",
        tone === "draft" ? "ring-primary-alpha-24" : "ring-stroke-soft-200",
        disabled && "opacity-70",
        className,
      )}
    >
      {banner}
      <textarea
        ref={innerRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        rows={minRows}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="block max-h-60 min-h-[76px] w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[16px] leading-6 text-text-strong-950 outline-none placeholder:text-text-soft-400 disabled:cursor-not-allowed sm:text-paragraph-sm"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        <div className="min-w-0 flex-1 truncate text-paragraph-xs text-text-soft-400">{meta}</div>
        <span className="hidden shrink-0 items-center gap-1 text-paragraph-xs text-text-soft-400 @3xl:inline-flex">
          <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
        </span>
        <Button.Root variant="primary" mode="filled" size="xsmall" onClick={onSubmit} disabled={!canSend} className="h-9 shrink-0 rounded-lg px-3" title="Send (Enter)">
          {sending ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiSendPlane2Fill} />}
          {sending ? "Sending…" : submitLabel}
        </Button.Root>
      </div>
    </div>
  );
}

/** The dock the composer sits in, pinned under the thread. */
export function ComposerDock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("shrink-0 space-y-2 border-t border-stroke-soft-200 bg-bg-weak-50/50 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:py-4", className)}>{children}</div>;
}

/** Inside the composer while an AI draft is loaded: what it is, and a way to stop using it. */
export function ComposerDraftBanner({ onClear, note = "Edit freely — approving sends it as the CRM draft." }: { onClear: () => void; note?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-primary-alpha-16 bg-primary-alpha-10 px-4 py-1.5">
      <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-primary-base" aria-hidden="true" fill="currentColor">
        <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 12l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
      </svg>
      <span className="text-label-xs text-text-strong-950">AI draft</span>
      <span className="min-w-0 flex-1 truncate text-paragraph-xs text-text-sub-600">{note}</span>
      <button type="button" onClick={onClear} className="shrink-0 text-label-xs text-text-sub-600 underline-offset-2 outline-none hover:text-text-strong-950 hover:underline focus-visible:underline">
        Don&apos;t use draft
      </button>
    </div>
  );
}
