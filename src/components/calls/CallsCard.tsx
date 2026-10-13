"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useRef, useState } from "react";
import { RiPhoneLine } from "@remixicon/react";
import { ErrorState } from "@/components/analytics/kit/ErrorState";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { EmptyState } from "@/components/page/EmptyState";
import { Skeleton } from "@/components/page/Skeletons";
import { errorMessage, formatDate } from "@/components/crm/crm-utils";
import { formatCallDuration } from "./formatElapsed";
import { CALL_POLL_INTERVAL_MS, CALL_POLL_TIMEOUT_MS } from "./polling";
import { useRefreshOnReturn } from "@/components/calling/useRefreshOnReturn";
import { listCalls } from "@/lib/calls/client";
import { cn } from "@/utils/cn";
import type { CallSummary } from "@/lib/calls/contract";
import { LiveCallStrip } from "@/components/calls/LiveCallStrip";
import { RecordingPlayer } from "./RecordingPlayer";
import { CallSessionBadge } from "./CallSessionBadge";
import { BRAND } from "@/lib/brand";

export function CallsCard({ personId, refreshKey }: { personId: string; refreshKey?: number }) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // Whose calls are on screen: a refresh for the same person dims them, a new person starts from skeletons.
  const loadedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await listCalls(personId);
      setCalls(response.calls);
      setError("");
      loadedFor.current = personId;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [personId]);

  useEffect(() => {
    if (loadedFor.current === personId) setRefreshing(true);
    else setLoading(true);
    void load();
  }, [load, personId, refreshKey]);
  useRefreshOnReturn(load);

  // Newest first, regardless of what order the API happens to return.
  const sorted = [...calls].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = sorted.some((call) => call.status === "pending" || call.status === "in_progress");
  const pollStartedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) { pollStartedAt.current = null; return; }
    pollStartedAt.current ??= Date.now();
    const interval = setInterval(() => {
      const startedAt = pollStartedAt.current;
      if (startedAt != null && Date.now() - startedAt > CALL_POLL_TIMEOUT_MS) { clearInterval(interval); return; }
      void load();
    }, CALL_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, load]);

  const mostRecentCallId = sorted[0]?.id ?? null;

  return (
    <div className="space-y-3">
      <LiveCallStrip callId={mostRecentCallId} serverStatus={sorted[0]?.status ?? null} onCancelled={() => void load()} />
      <Frame>
        <FrameHeader title="Calls" description={sorted.length ? `${sorted.length} WhatsApp call${sorted.length === 1 ? "" : "s"}, newest first` : `WhatsApp calls placed from ${BRAND.shortName}`} />
        <FramePanel aria-busy={refreshing || undefined} className={cn("p-0 transition-opacity sm:p-0", refreshing && "opacity-60")}>
          {loading ? (
            <div aria-busy="true" aria-label="Loading calls" className="divide-y divide-stroke-soft-200">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 px-4 py-3.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="ml-auto h-3 w-24" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-3"><ErrorState message={error} onRetry={() => void load()} /></div>
          ) : sorted.length ? (
            <div className="divide-y divide-stroke-soft-200">
              {sorted.map((call) => <CallRow key={call.id} call={call} />)}
            </div>
          ) : (
            <EmptyState compact icon={RiPhoneLine} title="No calls yet" description="Calls placed with the Call button show up here, with their recording." />
          )}
        </FramePanel>
      </Frame>
    </div>
  );
}

function CallRow({ call }: { call: CallSummary }) {
  const duration = formatCallDuration(call.durationMs);
  return (
    <div className="space-y-2 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <RiPhoneLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
        <span className="text-label-sm text-text-strong-950">{call.phone}</span>
        <CallSessionBadge status={call.status} />
        <span className="ml-auto text-paragraph-xs tabular-nums text-text-sub-600">
          {formatDate(call.startedAt ?? call.createdAt)}
          {duration ? ` · ${duration}` : ""}
        </span>
      </div>
      {(call.status === "failed" || call.status === "no_recording") && call.error && (
        <p className={call.status === "failed" ? "text-paragraph-xs text-error-dark" : "text-paragraph-xs text-text-sub-600"}>{call.error}</p>
      )}
      {call.hasRecording && (
        <RecordingPlayer callId={call.id} offsetMs={call.recordingOffsetMs} />
      )}
    </div>
  );
}
