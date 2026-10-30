import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { members } from "@/lib/auth/schema";
import { browserConnections } from "@/lib/browser/connected/schema";
import { BROWSER_TASK_MIN_VERSION, type ResearchSiteKey } from "@/lib/browser/connected/contract";
import { isOlderVersion } from "@/lib/calls/recorderRelease";
import { channelRules } from "@/lib/channels/rules.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { MESSAGING_SITES, type MessagingSite } from "./routes";
import { browserOutreachReady } from "./routes.server";

export type BrowserChannelStatus = {
  available: boolean;
  reason: string | null;
  senders: number;
  perSenderPerDay: number | null;
  /** Whose browser sends: the person asked about, else the workspace's most recently paired one. */
  userId: string | null;
  /** The messaging sites that browser's website access covers. */
  sites: MessagingSite[];
};

/**
 * Whether the browser can be a plan's channel: a person's browser is paired
 * with this workspace, on an extension that carries out tasks, with website
 * access to at least one messaging site. Chrome being offline right now does
 * not make it unavailable: the courier waits for it and says so.
 */
export async function browserChannelStatus(userId: string | null): Promise<BrowserChannelStatus> {
  const none = (reason: string): BrowserChannelStatus => ({ available: false, reason, senders: 0, perSenderPerDay: null, userId, sites: [] });
  if (!(await browserOutreachReady())) return none("the browser outreach migration has not been applied (scripts/add-browser-outreach.ts)");
  const workspaceMembers = db.select({ userId: members.userId }).from(members).where(eq(members.organizationId, currentOrganizationId()));
  const [row] = await db.select().from(browserConnections)
    .where(and(inOrg(browserConnections), eq(browserConnections.status, "active"), userId ? eq(browserConnections.userId, userId) : inArray(browserConnections.userId, workspaceMembers)))
    .orderBy(desc(browserConnections.pairedAt)).limit(1);
  if (!row) return none("no browser is connected (Connect browser in the chat, with the 22nd x ai Browser Assistant)");
  if (!row.extensionVersion || isOlderVersion(row.extensionVersion, BROWSER_TASK_MIN_VERSION)) {
    return { ...none(`the 22nd x ai Browser Assistant (${row.extensionVersion ?? "unknown version"}) is older than ${BROWSER_TASK_MIN_VERSION}, which sends messages: update it from Settings → WhatsApp → Integrations`), userId: row.userId };
  }
  const sites = MESSAGING_SITES.filter((site) => (row.sites as ResearchSiteKey[]).includes(site));
  if (!sites.length) return { ...none("the browser's website access covers none of X, Instagram, Facebook or LinkedIn (change it from the extension's popup)"), userId: row.userId };
  const rules = await channelRules("browser");
  return { available: true, reason: null, senders: 1, perSenderPerDay: Number(rules.newChatsPerDay), userId: row.userId, sites };
}
