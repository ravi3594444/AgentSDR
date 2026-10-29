"use client";

import { useCallback, useEffect, useState } from "react";
import type { RequestSummary } from "@/lib/assistant/requests.server";
import { useVisiblePolling } from "@/components/whatsapp/usePolling";
import { createResponseGate } from "@/components/crm/responseGate";
import { parseRequestSummary } from "./RequestSummaryView";

const POLL_MS = 15_000;

/**
 * One request's summary (requests.server.ts) for the chat's request card, so
 * the card and the panel beside the chat count from the same source.
 * `undefined` while loading, null without a key or when the request is not
 * found; a failed read keeps the last summary and the next refresh tries
 * again. Reloaded when the chat sees new activity (`refreshKey`), and every
 * 15 s while the request is open and the page is visible.
 */
export function useRequestSummary(key: string | null, refreshKey: string): RequestSummary | null | undefined {
  const [data, setData] = useState<{ key: string; value: RequestSummary | null } | null>(null);
  const [responses] = useState(createResponseGate);
  const load = useCallback(async () => {
    if (!key) return;
    const ticket = responses.restart();
    try {
      const response = await fetch(`/api/assistant/requests/${encodeURIComponent(key)}`, { cache: "no-store" });
      if (!responses.isCurrent(ticket)) return;
      if (response.status === 404) { setData({ key, value: null }); return; }
      if (!response.ok) return;
      const value = parseRequestSummary(await response.json());
      if (responses.isCurrent(ticket)) setData({ key, value });
    } catch {
      // Kept as last read; the next refresh tries again.
    }
  }, [key, responses]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); return () => { responses.restart(); }; }, [load, refreshKey, responses]);
  const current = data && data.key === key ? data.value : undefined;
  useVisiblePolling(() => void load(), POLL_MS, Boolean(current?.open));
  return key ? current : null;
}
