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

/** What read_webpage answers for a Reddit address: why it is not read here, and where Reddit is researched instead. */
export function redditRefusal(approvalRecorded: boolean): string {
  const instead = "Reddit posts and comments are searched with research_social_sources (Bright Data) when the owner turned Reddit research on. Nothing was read from Reddit.";
  return approvalRecorded
    ? `read_webpage does not read Reddit (approval recorded; a Reddit reader is not built yet). ${instead}`
    : `read_webpage does not read Reddit (its API needs Reddit's approval for this use, not recorded in Settings → Lead research → Research sources). ${instead}`;
}

/** A short hint of a Reddit app's client id: its last four characters, like an API key's hint. */
export function redditClientHint(clientId: string): string | null {
  const id = clientId.trim();
  return id ? `…${id.slice(-4)}` : null;
}
