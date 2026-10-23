import {
  RiRobot2Line,
  RiBookOpenLine,
  RiBugLine,
  RiLightbulbLine,
  RiShieldCheckLine,
  RiChat3Line,
  RiFilter3Line,
  RiGlobalLine,
  RiHistoryLine,
  RiInboxLine,
  RiLinkM,
  RiListCheck3,
  RiMegaphoneLine,
  RiChatSmile2Line,
  RiPhoneLine,
  RiSearchLine,
  RiSendPlaneLine,
  RiWebhookLine,
  RiCodeSSlashLine,
  RiDatabase2Line,
  RiGridLine,
  RiInstagramFill,
  RiLinkedinBoxFill,
  RiMailFill,
  RiSettings3Line,
  RiTimeLine,
  RiUserSearchLine,
  RiWhatsappFill,
  type RemixiconComponentType,
} from "@remixicon/react";
import { HUE } from "@/components/analytics/theme";
import { APP_VERSION, bugReportUrl, SUPPORT_LINKS } from "@/lib/support";
import { SETTINGS_HOME, visibleSettingsNav } from "@/components/settings/settingsNav";
import type { FeatureKey, FeatureState } from "@/lib/features/catalog";
import { isReleased } from "@/lib/release";

/**
 * The app's navigation, shared by the sidebar and the ⌘K palette.
 *
 * Shape: three destinations — Outreach, Inbox, Leads — then a collapsed
 * Advanced section holding the manual tools (one group per channel's
 * campaigns and inbox, sequences, data, developer pages), plus Getting
 * started and Settings pinned to the bottom. A link's `match` lists extra
 * path prefixes that should light it up (a record page belongs to Leads). An entry with a `feature` shows only while that
 * optional feature is on for the organization (GET /api/nav/badges says
 * which are); without the answer it stays hidden.
 */

/** Live counts from GET /api/nav/badges. */
export type NavBadges = {
  actionRequired: number;
  /** The Inbox's Needs you: records waiting on a person plus open owner decisions (crmInboxCountSql). */
  inbox: number;
  whatsappUnread: number;
  draftsAwaitingReview: number;
  /** Failing mailboxes + disconnected LinkedIn, WhatsApp and Instagram accounts. */
  accountsNeedingAttention: number;
  /** Leads waiting for a person: the assistant's open handoffs (Needs you). */
  needsYou: number;
  /** Incoming replies since the person last opened Activity → Replies (any chat, any channel). */
  newReplies: number;
  /** Background searches still queued or running. */
  openWork: number;
};
export type NavBadgeKey = keyof NavBadges;

/** What GET /api/nav/badges answers: the counts, and the organization's optional features. */
export type NavData = NavBadges & { features: FeatureState };

export type NavLink = {
  kind: "link";
  href: string;
  label: string;
  icon: RemixiconComponentType;
  badge?: NavBadgeKey;
  /** "count" shows the number; "dot" only flags that something needs a look. */
  badgeStyle?: "count" | "dot";
  match?: string[];
  feature?: FeatureKey;
};

export type NavGroup = {
  kind: "group";
  id: string;
  label: string;
  icon: RemixiconComponentType;
  /** Channel identity colour for the group's icon (the Analytics channel colours). */
  color?: string;
  children: NavLink[];
  /** Closed until opened, unless it holds the current page. */
  defaultOpen?: boolean;
  feature?: FeatureKey;
};

export type NavEntry = NavLink | NavGroup;
export type NavSection = {
  label?: string;
  entries: NavEntry[];
  /** Closed until opened (the label is the toggle), unless it holds the current page. */
  collapsible?: boolean;
  /** Key for the stored open/closed choice of a collapsible section. */
  id?: string;
};

const link = (href: string, label: string, icon: RemixiconComponentType, extra: Partial<NavLink> = {}): NavLink => ({ kind: "link", href, label, icon, ...extra });

/** Entries only for features this release offers (src/lib/release.ts). */
const when = <T,>(released: boolean, ...entries: T[]): T[] => (released ? entries : []);

export const NAV_SECTIONS: NavSection[] = [
  {
    entries: [
      // The chat, its requests and the reports; Activity and Overview were its old names.
      link("/assistant", "Outreach", RiRobot2Line, { match: ["/activity", "/analytics"] }),
      link("/inbox", "Inbox", RiInboxLine, { badge: "inbox", match: ["/crm/actions", "/outreach/inbox", "/linkedin/messages", "/calling/messages", "/instagram/messages"] }),
      link("/leads", "Leads", RiUserSearchLine, { match: ["/crm/records", "/crm/pipeline"] }),
    ],
  },
  {
    // Manual tools: campaigns made by hand, each channel's own inbox, sequences, data, developer pages.
    label: "Advanced",
    id: "advanced",
    collapsible: true,
    entries: [
      {
        kind: "group",
        id: "email",
        label: "Email",
        icon: RiMailFill,
        color: HUE.orange,
        children: [
          link("/outreach/campaigns", "Campaigns", RiSendPlaneLine),
          ...when(isReleased("channelInboxes"), link("/outreach/inbox", "Inbox", RiInboxLine)),
        ],
      },
      {
        kind: "group",
        id: "linkedin",
        label: "LinkedIn",
        icon: RiLinkedinBoxFill,
        color: HUE.blue,
        children: [
          link("/linkedin/campaigns", "Campaigns", RiMegaphoneLine),
          ...when(isReleased("channelInboxes"), link("/linkedin/messages", "Messages", RiChat3Line)),
          ...when(isReleased("linkedinSearch"), link("/linkedin/search", "Search", RiSearchLine)),
        ],
      },
      {
        kind: "group",
        id: "whatsapp",
        label: "WhatsApp",
        icon: RiWhatsappFill,
        color: HUE.green,
        children: [
          link("/whatsapp/campaigns", isReleased("calling") ? "Message campaigns" : "Campaigns", RiChatSmile2Line, { match: ["/whatsapp/"] }),
          ...when(isReleased("calling"), link("/calling/campaigns", "Call campaigns", RiPhoneLine, { match: ["/calling/"] })),
          ...when(isReleased("channelInboxes"), link("/calling/messages", "Messages", RiChat3Line, { badge: "whatsappUnread" })),
        ],
      },
      ...when<NavEntry>(isReleased("channelInboxes"), {
        // Only for organizations that turned Instagram messages on.
        kind: "group",
        id: "instagram",
        label: "Instagram",
        icon: RiInstagramFill,
        color: HUE.pink,
        feature: "instagram",
        children: [link("/instagram/messages", "Messages", RiChat3Line)],
      }),
      link("/crm/sequences", "Sequences", RiTimeLine),
      ...when<NavEntry>(isReleased("tables"), link("/tables", "Tables", RiGridLine)),
      ...when<NavEntry>(isReleased("prospecting"), {
        kind: "group",
        id: "prospecting",
        label: "Prospecting",
        icon: RiDatabase2Line,
        children: [
          link("/domains", "All domains", RiGlobalLine),
          link("/campaigns", "Qualification campaigns", RiFilter3Line),
        ],
      }),
      {
        kind: "group",
        id: "developers",
        label: "Developers",
        icon: RiCodeSSlashLine,
        children: [
          link("/linkedin/connections", "Connections", RiLinkM),
          link("/linkedin/jobs", "Job history", RiHistoryLine),
          link("/linkedin/webhooks", "LinkedIn webhooks", RiWebhookLine),
        ],
      },
    ],
  },
];

export const NAV_FOOTER: NavEntry[] = [
  // Pinned beside Settings rather than at the top, so finished setup never pushes the day's work down.
  link("/getting-started", "Getting started", RiListCheck3),
  link(SETTINGS_HOME, "Settings", RiSettings3Line, { match: ["/settings"], badge: "accountsNeedingAttention", badgeStyle: "dot" }),
];

function featureOn(entry: { feature?: FeatureKey }, features: FeatureState | null): boolean {
  return !entry.feature || Boolean(features?.[entry.feature]);
}

/** The sections this organization sees: entries whose feature is off (or not known yet) are left out. */
export function visibleNavSections(features: FeatureState | null): NavSection[] {
  return NAV_SECTIONS
    .map((section) => ({
      ...section,
      entries: section.entries
        .filter((entry) => featureOn(entry, features))
        .map((entry) => (entry.kind === "group" ? { ...entry, children: entry.children.filter((child) => featureOn(child, features)) } : entry)),
    }))
    .filter((section) => section.entries.length > 0);
}

export function allLinks(): NavLink[] {
  const entries = [...NAV_SECTIONS.flatMap((s) => s.entries), ...NAV_FOOTER];
  return entries.flatMap((e) => (e.kind === "group" ? e.children : [e]));
}

/** The one link that owns `pathname`: the longest matching href or `match` prefix. */
export function activeHref(pathname: string): string | undefined {
  let best: { href: string; length: number } | undefined;
  for (const l of allLinks()) {
    for (const prefix of [l.href, ...(l.match ?? [])]) {
      const hit = pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
      if (hit && (!best || prefix.length > best.length)) best = { href: l.href, length: prefix.length };
    }
  }
  return best?.href;
}

/** Every destination for the ⌘K palette: nav pages, settings screens, and "create" shortcuts. */
export type PaletteItem = { href: string; label: string; group: string; icon: RemixiconComponentType; keywords?: string; /** Opens in a new tab instead of navigating in the app. */ external?: boolean };

export function paletteItems(features: FeatureState | null = null): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const section of visibleNavSections(features)) {
    for (const e of section.entries) {
      if (e.kind === "link") items.push({ href: e.href, label: e.label, group: section.label ?? "Pages", icon: e.icon });
      else for (const c of e.children) items.push({ href: c.href, label: `${e.label} · ${c.label}`, group: section.label ?? "Pages", icon: c.icon });
    }
  }
  for (const e of NAV_FOOTER) {
    if (e.kind === "group") for (const c of e.children) items.push({ href: c.href, label: c.label, group: e.label, icon: c.icon });
  }
  for (const g of visibleSettingsNav(features)) {
    for (const s of g.items) {
      if (!s.tabs) items.push({ href: s.href, label: s.label, group: "Settings", icon: s.icon, keywords: g.label });
      else for (const t of s.tabs) items.push({ href: t.href, label: `${s.label} · ${t.label}`, group: "Settings", icon: t.icon, keywords: g.label });
    }
  }
  // The views inside the three destinations, so "all conversations" or "board" finds them.
  items.push(
    { href: "/inbox?view=needs_you", label: "Inbox · Needs you", group: "Pages", icon: RiInboxLine, keywords: "action required approve drafts decisions" },
    { href: "/inbox?view=all", label: "Inbox · All conversations", group: "Pages", icon: RiInboxLine, keywords: "replies messages" },
    { href: "/leads?view=board", label: "Leads · Board", group: "Pages", icon: RiUserSearchLine, keywords: "pipeline" },
  );
  items.push(
    { href: "/outreach/campaigns/new", label: "New email campaign", group: "Create", icon: RiMailFill },
    { href: "/linkedin/campaigns/new", label: "New LinkedIn campaign", group: "Create", icon: RiLinkedinBoxFill },
  );
  items.push(
    { href: SUPPORT_LINKS.docs, label: "Documentation", group: "Help", icon: RiBookOpenLine, external: true },
    { href: bugReportUrl(APP_VERSION), label: "Report a bug", group: "Help", icon: RiBugLine, external: true },
    { href: SUPPORT_LINKS.featureRequest, label: "Request a feature", group: "Help", icon: RiLightbulbLine, external: true },
    { href: SUPPORT_LINKS.community, label: "Ask the community", group: "Help", icon: RiChat3Line, external: true },
    { href: SUPPORT_LINKS.security, label: "Report a security issue", group: "Help", icon: RiShieldCheckLine, external: true },
  );
  return items;
}
