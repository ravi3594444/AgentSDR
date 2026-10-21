"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RiCheckLine, RiExternalLinkLine, RiFireLine, RiTimeLine, RiUserVoiceLine } from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import type { NeedsYouItem } from "@/lib/assistant/handoff.server";
import { cn } from "@/utils/cn";

/**
 * Needs you: every lead waiting for a person, most urgent first (ready to
 * buy, then the longest wait), with what they want and what to do. An item
 * leaves the list when the owner answers here, replies in the chat (from
 * the app or their phone), or marks it done.
 */

export type NeedsYouPayload = { items: NeedsYouItem[]; reviewWaiting: number; actionRequired?: number };

const POLL_MS = 10_000;

const CHANNEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn" };

function tone(priority: number): "red" | "orange" | "gray" {
  return priority === 0 ? "red" : priority <= 3 ? "orange" : "gray";
}

function Item({ item, onChanged }: { item: NeedsYouItem; onChanged: () => void }) {
  const [answer, setAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "answer" | "resolve") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistant/decisions/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "answer" ? { action, answer } : { action }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={cn("rounded-xl border bg-bg-white-0 p-3 sm:p-4", item.priority === 0 ? "border-error-base" : "border-stroke-soft-200")} data-testid="needs-you-item">
      <div className="flex flex-wrap items-center gap-2">
        <Badge.Root variant="lighter" size="small" color={tone(item.priority)}>
          {item.priority === 0 ? <RiFireLine className="mr-0.5 size-3" aria-hidden /> : null}
          {item.label}
        </Badge.Root>
        <p className="min-w-0 flex-1 break-words text-label-sm text-text-strong-950">
          {item.leadName}
          {item.company && <span className="text-text-sub-600"> · {item.company}</span>}
        </p>
        <span className="inline-flex items-center gap-1 text-paragraph-xs text-text-soft-400" title={new Date(item.createdAt).toLocaleString()}>
          <RiTimeLine className="size-3.5" aria-hidden /> waiting {item.waited}
        </span>
      </div>
      <p className="mt-2 text-paragraph-sm text-text-strong-950">{item.brief ?? item.reason}</p>
      {item.leadMessage && (
        <blockquote className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap border-l-2 border-stroke-sub-300 pl-2 text-paragraph-xs text-text-sub-600">{item.leadMessage}</blockquote>
      )}
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-paragraph-xs text-text-sub-600">
        {item.channel && <span>{CHANNEL[item.channel] ?? item.channel}</span>}
        {item.handoverSentAt
          ? <span className="inline-flex items-center gap-1"><RiUserVoiceLine className="size-3.5" aria-hidden /> They were told you will reply personally</span>
          : null}
        {item.newerMessages > 0 && <span className="text-warning-base">{item.newerMessages} new {item.newerMessages === 1 ? "message" : "messages"} since</span>}
      </p>
      {answering && (
        <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={2} autoFocus
          placeholder={`${item.decision} Your answer is saved for later replies.`} aria-label="Your answer"
          className="mt-2 w-full resize-y rounded-lg bg-bg-weak-50 px-2.5 py-2 text-paragraph-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-primary-base" />
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="mr-auto text-label-xs text-text-strong-950">{item.action}</span>
        {item.crmRecordId && (
          <Link href={`/crm/records/${item.crmRecordId}`} className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-label-xs text-primary-base ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
            Open chat <RiExternalLinkLine className="size-3.5" aria-hidden />
          </Link>
        )}
        {item.takesAnswer && !answering && (
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => setAnswering(true)}>Answer</Button.Root>
        )}
        {answering && (
          <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy || !answer.trim()} onClick={() => void act("answer")}>Save and reply</Button.Root>
        )}
        <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={() => void act("resolve")} title="Settled. The assistant keeps answering this chat.">
          <Button.Icon as={RiCheckLine} /> Done
        </Button.Root>
      </div>
      {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
    </li>
  );
}

/**
 * The leads waiting for a person. `compact` is the one-line banner above the
 * chat; `inbox` is the cards at the top of the Inbox's Needs you, filtered to
 * one channel when the Inbox is, and nothing at all when no decision waits
 * (the rows below say the rest).
 */
export default function NeedsYouList({ initial, compact = false, inbox = false, channel, onChanged, onCount }: {
  initial: NeedsYouPayload | null;
  compact?: boolean;
  inbox?: boolean;
  channel?: string;
  /** After a decision is answered or resolved, so the Inbox can refresh its counts. */
  onChanged?: () => void;
  /** How many decisions are shown, for the Inbox's Needs you count. */
  onCount?: (count: number) => void;
}) {
  const [payload, setPayload] = useState<NeedsYouPayload | null>(initial);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/assistant/needs-you", { cache: "no-store" });
      const body = (await response.json()) as NeedsYouPayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setPayload(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const first = initial ? null : setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      if (first) clearTimeout(first);
      clearInterval(timer);
    };
  }, [initial, load]);

  const items = (payload?.items ?? []).filter((item) => !channel || item.channel === channel);
  const changed = () => { void load(); onChanged?.(); };
  useEffect(() => { onCount?.(items.length); }, [onCount, items.length]);
  const review = payload?.reviewWaiting ?? 0;
  const actionRequired = payload?.actionRequired ?? 0;
  if (compact) {
    if (!items.length) return null;
    const ready = items.filter((item) => item.priority === 0).length;
    return (
      <Link href="/inbox?view=needs_you" data-testid="needs-you-banner"
        className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl border border-stroke-soft-200 bg-bg-weak-50/60 px-3.5 py-3 text-paragraph-sm text-text-strong-950 outline-none transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200"><RiFireLine className={cn("size-4", ready ? "text-error-base" : "text-warning-base")} aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-label-xs">{items.length} {items.length === 1 ? "conversation needs" : "conversations need"} you{ready ? ` · ${ready} ready to buy` : ""}</span>
          <span className="mt-0.5 block truncate text-paragraph-xs text-text-sub-600">{items.slice(0, 2).map((item) => item.leadName).join(", ")}{items.length > 2 ? ` and ${items.length - 2} more` : ""}</span>
        </span>
        <span className="shrink-0 text-label-xs text-primary-base">Review <span aria-hidden="true">↗</span></span>
      </Link>
    );
  }
  if (inbox) {
    if (!items.length && !error) return null;
    return (
      <section id="needs-you" className="scroll-mt-4 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3 sm:p-4" aria-labelledby="needs-you-title" data-testid="inbox-decisions">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id="needs-you-title" className="text-label-md text-text-strong-950">Decisions only you can make</h2>
          {items.length > 0 && <span className="text-paragraph-xs text-text-sub-600">{items.length} {items.length === 1 ? "lead is" : "leads are"} waiting for your answer, most urgent first</span>}
        </div>
        {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
        {items.length > 0 && <ul className="mt-3 space-y-2">{items.map((item) => <Item key={item.id} item={item} onChanged={changed} />)}</ul>}
      </section>
    );
  }
  return (
    <section id="needs-you" className="scroll-mt-4 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3 sm:p-4" aria-labelledby="needs-you-title">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 id="needs-you-title" className="text-label-md text-text-strong-950">Needs you</h2>
        <span className="text-paragraph-xs text-text-sub-600">
          {items.length
            ? `${items.length} ${items.length === 1 ? "lead is" : "leads are"} waiting for a person, most urgent first`
            : actionRequired
              ? `No decisions wait for you here; ${actionRequired} ${actionRequired === 1 ? "conversation waits" : "conversations wait"} in the Inbox.`
              : "Nobody is waiting for you."}
        </span>
      </div>
      {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
      {items.length > 0 && <ul className="mt-3 space-y-2">{items.map((item) => <Item key={item.id} item={item} onChanged={changed} />)}</ul>}
      {review > 0 && (
        <p className="mt-3 text-paragraph-xs text-text-sub-600">
          {review} {review === 1 ? "reply waits" : "replies wait"} for your review (Review mode) in{" "}
          <Link href="/inbox?view=needs_you" className="text-primary-base hover:underline">the Inbox</Link>.
        </p>
      )}
    </section>
  );
}
