"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { RiAttachment2, RiCheckDoubleLine, RiCheckLine } from "@remixicon/react";
import { Bubble, ChatComposer, DaySeparator, MessageCaption } from "@/components/inbox/shell/Conversation";
import { ChannelTag } from "@/components/inbox/shell/InboxShell";
import type { WhatsappMessage } from "@/lib/whatsapp/contract";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatMessageTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

const ORIGIN_LABEL = {
  lead: "",
  agentsdr: `Sent from ${BRAND.shortName}`,
  phone: "Sent from phone",
} as const;

function Ticks({ message }: { message: WhatsappMessage }) {
  if (message.direction !== "outbound") return null;
  if (message.readAt) return <RiCheckDoubleLine className="size-3.5 text-primary-base" aria-label="Read" />;
  if (message.deliveredAt) return <RiCheckDoubleLine className="size-3.5" aria-label="Delivered" />;
  return <RiCheckLine className="size-3.5" aria-label="Sent" />;
}

/**
 * Oldest-first messages with day separators. A run of messages from one side
 * opens with a caption — who wrote it and, for outbound, whether it was sent
 * from AgentSDR or from the phone. Each bubble carries its time and ticks.
 * Scrolls to the bottom when the thread changes, and follows new messages
 * while the reader is near the bottom.
 */
export function WhatsappMessageList({
  messages,
  threadKey,
  className,
  emptyText = "No messages yet",
  leadName,
}: {
  messages: WhatsappMessage[];
  /** Changes when a different chat is opened, so the view jumps to the bottom. */
  threadKey: string;
  className?: string;
  emptyText?: string;
  /** Who the inbound side is, for the run captions; without it inbound runs are uncaptioned. */
  leadName?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef<string | null>(null);
  const lastCount = useRef(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const switched = lastKey.current !== threadKey;
    const grew = messages.length > lastCount.current;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (switched || (grew && nearBottom)) element.scrollTop = element.scrollHeight;
    lastKey.current = threadKey;
    lastCount.current = messages.length;
  }, [messages, threadKey]);

  const firstName = leadName?.trim().split(/\s+/)[0];

  return (
    <div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6", className)}>
      {messages.length === 0 ? (
        <p className="py-8 text-center text-paragraph-sm text-text-soft-400">{emptyText}</p>
      ) : (
        messages.map((message, index) => {
          const previous = messages[index - 1];
          const next = messages[index + 1];
          const outbound = message.direction === "outbound";
          const newDay = !previous || dayKey(previous.sentAt) !== dayKey(message.sentAt);
          const sameRun = (other: WhatsappMessage | undefined) =>
            Boolean(other) && dayKey(other!.sentAt) === dayKey(message.sentAt) && other!.direction === message.direction && other!.origin === message.origin;
          const groupStart = !sameRun(previous);
          const groupEnd = !sameRun(next);
          const label = outbound ? ORIGIN_LABEL[message.origin] : "";
          const who = outbound ? "You" : firstName;
          return (
            <div key={message.id}>
              {newDay && <DaySeparator date={new Date(message.sentAt)} />}
              <div className={cn("flex flex-col", outbound ? "items-end" : "items-start", groupStart ? "mt-5" : "mt-1")}>
                {groupStart && (who || label) && (
                  <MessageCaption outbound={outbound} who={who} detail={label} />
                )}
                <Bubble outbound={outbound} first={groupStart} last={groupEnd}
                  footer={<><span className="tabular-nums" suppressHydrationWarning>{formatMessageTime(message.sentAt)}</span><Ticks message={message} /></>}
                >
                  {message.attachments.map((attachment, attachmentIndex) => (
                    <p key={attachment.id ?? attachmentIndex} className="mb-1 flex items-center gap-1 text-paragraph-xs text-text-sub-600">
                      <RiAttachment2 className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{attachment.name || attachment.type || "Attachment"}</span>
                    </p>
                  ))}
                  {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
                </Bubble>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Message box: Enter sends, Shift+Enter breaks the line. `onSend` should
 * throw on failure; the message (including the API's 409/429 guardrail
 * refusals) is shown inline and the text is kept so it can be retried.
 */
export function WhatsappComposer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder = "Write a WhatsApp message…",
  rows = 2,
  meta,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => Promise<unknown>;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  /** The composer's meta line — which number it sends from. Defaults to the channel. */
  meta?: ReactNode;
  className?: string;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // A different draft (another chat, a new prefill) clears the previous error.
  const errorFor = useRef(value);
  useEffect(() => {
    if (errorFor.current !== value) {
      errorFor.current = value;
      setError("");
    }
  }, [value]);

  const submit = async () => {
    const text = value.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    setError("");
    try {
      await onSend(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={className}>
      {error && (
        <div role="alert" className="mb-2 rounded-lg bg-error-lighter px-3 py-2 text-paragraph-xs text-error-dark ring-1 ring-inset ring-error-light">
          {error}
        </div>
      )}
      <ChatComposer
        value={value}
        onChange={onChange}
        onSubmit={() => void submit()}
        sending={sending}
        disabled={disabled}
        placeholder={placeholder}
        ariaLabel="WhatsApp message"
        minRows={Math.max(1, rows - 1)}
        meta={meta ?? <ChannelTag channel="whatsapp" />}
      />
    </div>
  );
}
