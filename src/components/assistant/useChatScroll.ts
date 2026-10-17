"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Follow replies only while the reader is at the bottom, including growing tool cards. */
export function useChatScroll(threadId: string, revision: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previousThread = useRef(threadId);
  const [showLatest, setShowLatest] = useState(false);

  const updatePosition = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    setShowLatest(!pinned.current);
  }, []);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    setShowLatest(false);
  }, []);

  useLayoutEffect(() => {
    if (previousThread.current !== threadId) {
      previousThread.current = threadId;
      jumpToLatest();
    } else if (pinned.current) {
      const element = scroller.current;
      if (element) element.scrollTop = element.scrollHeight;
    }
  }, [threadId, revision, jumpToLatest]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const body = content.current;
    if (!element || !body) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
      updatePosition();
    });
    observer.observe(body);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updatePosition]);

  return { scroller, content, showLatest, updatePosition, jumpToLatest };
}
