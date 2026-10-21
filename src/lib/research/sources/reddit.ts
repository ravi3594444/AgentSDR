/**
 * Reddit is not read by the assistant's own tools (read_webpage, web
 * research): its API needs Reddit's approval for this use, and the owner
 * decided on no reader and no workaround here (no anonymous JSON, scraping,
 * RSS or browser automation). The one path is social research through
 * Bright Data (src/lib/discovery/socialResearch.server.ts), which an owner
 * turns on per organization in the Bright Data settings, accepting that
 * Reddit's terms restrict automated collection. Reddit's rules also forbid
 * automated unsolicited messages: no Reddit sender exists, anywhere.
 */

// reddit.com and every subdomain (www, old, new, np, m, …); redd.it and its media hosts.
const REDDIT_HOST = /(?:^|\.)(?:reddit\.com|redd\.it)$/i;

export function isRedditHost(hostname: string): boolean {
  return REDDIT_HOST.test(hostname.replace(/\.$/, ""));
}

/** What read_webpage answers for a Reddit address. */
export function redditRefusal(approvalRecorded: boolean): string {
  return approvalRecorded
    ? "Reddit is unavailable to research: approval recorded; a Reddit reader is not built yet. Nothing was read from Reddit."
    : "Reddit is unavailable to research: its API needs Reddit's approval for this use, and that approval is not recorded (Settings → Lead research → Research sources). Nothing was read from Reddit.";
}

/** A short hint of a Reddit app's client id: its last four characters, like an API key's hint. */
export function redditClientHint(clientId: string): string | null {
  const id = clientId.trim();
  return id ? `…${id.slice(-4)}` : null;
}
