import type { GmailWatchRegistration } from "@/lib/platform/catalog";

/** What a renewal amounts to for one organization, as stored for Settings and Getting Started. */
export function watchRegistration(results: { emailAddress: string; ok: boolean; error?: string }[], skippedBecause?: string): GmailWatchRegistration {
  const at = new Date().toISOString();
  if (skippedBecause) return { status: "skipped", at, registered: 0, attempted: 0, message: skippedBecause };
  const registered = results.filter((result) => result.ok).length;
  const failures = results.filter((result) => !result.ok);
  const message = failures.length
    ? failures.slice(0, 3).map((failure) => `${failure.emailAddress}: ${failure.error ?? "failed"}`).join("; ")
    : undefined;
  return {
    status: !results.length ? "skipped" : !failures.length ? "registered" : registered ? "partial" : "failed",
    at,
    registered,
    attempted: results.length,
    ...(message ? { message } : results.length ? {} : { message: "No connected mailbox to watch." }),
  };
}
