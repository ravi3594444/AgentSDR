"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RiLoader4Line } from "@remixicon/react";
import { DocsLink } from "@/components/page/DocsLink";
import { WhatsappComposer, WhatsappMessageList } from "@/components/whatsapp/WhatsappThread";
import { useVisiblePolling, WHATSAPP_POLL_INTERVAL_MS } from "@/components/whatsapp/usePolling";
import { errorMessage } from "@/components/crm/crm-utils";
import { getPersonWhatsappThread, sendWhatsapp } from "@/lib/whatsapp/client";
import type { PersonWhatsappThreadResponse } from "@/lib/whatsapp/contract";
import { cn } from "@/utils/cn";

/**
 * A lead's WhatsApp thread with a composer, from GET /api/whatsapp/people/:id/thread
 * and POST /api/whatsapp/send. Used by the Calling contact panel and the CRM
 * record page.
 *
 * When no linked number can send (`canSend` false), a `fallbackSend` — the
 * Calling panel's open-in-WhatsApp-Web flow — takes over; without one the
 * composer is disabled. Either way the hint links to /settings/whatsapp-accounts.
 */
export function PersonWhatsappPanel({
  personId,
  campaignContactId,
  callSessionId,
  prefill,
  fallbackSend,
  onSent,
  heightClass = "h-72",
  className,
  blockedReason,
  composerLabel,
}: {
  personId: string;
  campaignContactId?: string | null;
  /** The call this message follows up (the latest one), when there is one. */
  callSessionId?: string | null;
  /** Puts text in the composer each time `key` changes (a call-status template). */
  prefill?: { key: number; text: string } | null;
  fallbackSend?: (text: string) => Promise<unknown>;
  onSent?: () => void;
  heightClass?: string;
  className?: string;
  blockedReason?: string;
  composerLabel?: string;
}) {
  const [data, setData] = useState<PersonWhatsappThreadResponse | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");

  const request = useRef(0);
  const load = useCallback(async () => {
    const mine = ++request.current;
    try {
      const response = await getPersonWhatsappThread(personId);
      if (mine !== request.current) return;
      setData(response);
      setError("");
    } catch (cause) {
      if (mine === request.current) setError(errorMessage(cause));
    }
  }, [personId]);

  useEffect(() => {
    setData(null);
    setDraft("");
    void load();
  }, [load]);
  useVisiblePolling(() => void load(), WHATSAPP_POLL_INTERVAL_MS);

  const prefillKey = prefill?.key;
  useEffect(() => {
    if (prefill && prefillKey !== undefined) setDraft(prefill.text);
    // Only a new key re-applies the template; the text itself may be edited since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);

  const canSend = data?.canSend ?? false;
  const send = async (text: string) => {
    if (canSend) {
      await sendWhatsapp({ personId, text, campaignContactId: campaignContactId ?? null, callSessionId: callSessionId ?? null });
    } else if (fallbackSend) {
      await fallbackSend(text);
    }
    setDraft("");
    onSent?.();
    await load();
  };

  return (
    <div className={cn("space-y-2", className)}>
      {error && !data && <p role="alert" className="text-paragraph-xs text-error-dark">{error}</p>}
      {!data && !error ? (
        <div className={cn("flex items-center justify-center rounded-xl bg-bg-weak-50/60 ring-1 ring-inset ring-stroke-soft-200", heightClass)}>
          <RiLoader4Line className="size-5 animate-spin text-text-soft-400" aria-hidden="true" />
        </div>
      ) : data ? (
        <div className={cn("flex flex-col overflow-hidden rounded-xl ring-1 ring-inset ring-stroke-soft-200", heightClass)}>
          <WhatsappMessageList messages={data.messages} threadKey={personId} emptyText="No WhatsApp messages yet." className="px-3 py-2" />
        </div>
      ) : null}
      {data && !canSend && !blockedReason && (
        <p className="text-paragraph-xs text-text-sub-600">
          {fallbackSend ? "No WhatsApp number is linked, so this opens WhatsApp Web instead. " : "No WhatsApp number is linked, so messages cannot be sent from here. "}
          <Link href="/settings/whatsapp-accounts" className="text-primary-base hover:underline">Link a number</Link>
          {" · "}
          <DocsLink page="whatsapp/accounts#link-a-number" appearance="inline" className="font-normal" />
        </p>
      )}
      {blockedReason && <p role="status" className="text-paragraph-xs text-text-sub-600">{blockedReason}</p>}
      {composerLabel && !blockedReason && <p className="text-paragraph-xs text-text-soft-400">{composerLabel}</p>}
      <WhatsappComposer
        value={draft}
        onChange={setDraft}
        onSend={send}
        disabled={Boolean(blockedReason) || !data || (!canSend && !fallbackSend)}
        rows={3}
        placeholder={canSend || !fallbackSend ? "Write a WhatsApp message… (Enter to send, Shift+Enter for new line)" : "Write a message to open in WhatsApp Web…"}
      />
    </div>
  );
}
