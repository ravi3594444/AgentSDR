"use client";

import { useEffect } from "react";

/**
 * Overview's old address. Its Needs you list moved to the Inbox and its
 * numbers to Reports; the alert emails linked `#needs-you`, which never
 * reaches the server, so the fragment is read here and the query kept.
 */
export default function OldOverviewPage() {
  useEffect(() => {
    const { hash, search } = window.location;
    window.location.replace(hash === "#needs-you" ? "/inbox?view=needs_you" : `/assistant/reports${search}`);
  }, []);
  return <p className="p-6 text-paragraph-sm text-text-sub-600">Opening Reports…</p>;
}
