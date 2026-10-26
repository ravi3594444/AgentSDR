"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readRequestJson } from "./requestRead";

type ReadState<T> = { url: string | null; data: T | null; error: string | null; pending: boolean };

/** One read at a time; a new view or manual retry invalidates older responses. */
export function useRequestRead<T>(url: string | null, parse: (value: unknown) => T) {
  const [state, setState] = useState<ReadState<T>>({ url: null, data: null, error: null, pending: false });
  const active = useRef<{ controller: AbortController; url: string } | null>(null);
  const reload = useCallback(async (background = false) => {
    if (!url || (background && active.current?.url === url)) return;
    active.current?.controller.abort();
    const request = { controller: new AbortController(), url };
    active.current = request;
    setState((previous) => ({ url, data: previous.url === url ? previous.data : null, error: previous.url === url && background ? previous.error : null, pending: true }));
    try {
      const data = await readRequestJson(url, parse, request.controller.signal);
      if (active.current === request) setState({ url, data, error: null, pending: false });
    } catch (cause) {
      if (active.current === request) setState((previous) => ({ url, data: previous.url === url ? previous.data : null, error: cause instanceof Error ? cause.message : String(cause), pending: false }));
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [url, parse]);
  useEffect(() => {
    void reload();
    return () => { active.current?.controller.abort(); active.current = null; };
  }, [reload]);
  return { data: state.url === url ? state.data : null, error: state.url === url ? state.error : null, pending: Boolean(url && (state.url !== url || state.pending)), reload };
}
