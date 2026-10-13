import {
  RiBarChartBoxLine,
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
  RiLinkedinBoxFill,
  RiMailFill,
  RiRouteLine,
  RiSettings3Line,
  RiTimeLine,
  RiTodoLine,
  RiUserSearchLine,
  RiWhatsappFill,
  type RemixiconComponentType,
} from "@remixicon/react";
import { HUE } from "@/components/analytics/theme";
import { APP_VERSION, bugReportUrl, SUPPORT_LINKS } from "@/lib/support";
import { SETTINGS_HOME, SETTINGS_NAV } from "@/components/settings/settingsNav";
import { isReleased } from "@/lib/release";

/**
 * The app's navigation, shared by the sidebar and the ⌘K palette.
 *
 * Shape: a few labelled sections of links and collapsible groups (one group
 * per outreach channel), plus footer entries pinned to the bottom. A link's
 * `match` lists extra path prefixes that should light it up (a record page
 * belongs to Leads).
 */

/** Live counts from GET /api/nav/badges. */
export type NavBadges = {
  actionRequired: number;
  whatsappUnread: number;
  draftsAwaitingReview: number;
  /** Failing mailboxes + disconnected LinkedIn and WhatsApp accounts. */
  accountsNeedingAttention: number;
};
export type NavBadgeKey = keyof NavBadges;

export type NavLink = {
  kind: "link";
  href: string;
  label: string;
  icon: RemixiconComponentType;
  badge?: NavBadgeKey;
  /** "count" shows the number; "dot" only flags that something needs a look. */
  badgeStyle?: "count" | "dot";
  match?: string[];
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
};

export type NavEntry = NavLink | NavGroup;
export type NavSection = { label?: string; entries: NavEntry[] };

const link = (href: string, label: string, icon: RemixiconComponentType, extra: Partial<NavLink> = {}): NavLink => ({ kind: "link", href, label, icon, ...extra });

/** Entries only for features this release offers (src/lib/release.ts). */
const when = <T,>(released: boolean, ...entries: T[]): T[] => (released ? entries : []);

export const NAV_SECTIONS: NavSection[] = [
  {
    entries: [
      link("/analytics", "Analytics", RiBarChartBoxLine),
      link("/crm/actions", "Action required", RiTodoLine, { badge: "actionRequired" }),
      link("/leads", "Leads", RiUserSearchLine, { match: ["/crm/records"] }),
    ],
  },
  {
    label: "Outreach",
    entries: [
      {
        kind: "group",
        id: "email",
        label: "Email",
        icon: RiMailFill,
        color: HUE.orange,
        children: [
          link("/outreach/campaigns", "Campaigns", RiSendPlaneLine),
          link("/outreach/inbox", "Inbox", RiInboxLine),
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
          link("/linkedin/messages", "Messages", RiChat3Line),
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
          link("/calling/messages", "Messages", RiChat3Line, { badge: "whatsappUnread" }),
        ],
      },
    ],
  },
  {
    label: "CRM",
    entries: [
      link("/crm/pipeline", "Pipeline", RiRouteLine),
      link("/crm/sequences", "Sequences", RiTimeLine),
    ],
  },
  ...when<NavSection>(isReleased("tables") || isReleased("prospecting"), {
    label: "Data",
    entries: [
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
    ],
  }),
];

export const NAV_FOOTER: NavEntry[] = [
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
  // Pinned beside Settings rather than at the top, so finished setup never pushes campaign and inbox work down.
  link("/getting-started", "Getting started", RiListCheck3),
  link(SETTINGS_HOME, "Settings", RiSettings3Line, { match: ["/settings"], badge: "accountsNeedingAttention", badgeStyle: "dot" }),
];

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

export function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const section of NAV_SECTIONS) {
    for (const e of section.entries) {
      if (e.kind === "link") items.push({ href: e.href, label: e.label, group: section.label ?? "Pages", icon: e.icon });
      else for (const c of e.children) items.push({ href: c.href, label: `${e.label} · ${c.label}`, group: section.label ?? "Pages", icon: c.icon });
    }
  }
  for (const e of NAV_FOOTER) {
    if (e.kind === "group") for (const c of e.children) items.push({ href: c.href, label: c.label, group: e.label, icon: c.icon });
  }
  for (const g of SETTINGS_NAV) {
    for (const s of g.items) {
      if (!s.tabs) items.push({ href: s.href, label: s.label, group: "Settings", icon: s.icon, keywords: g.label });
      else for (const t of s.tabs) items.push({ href: t.href, label: `${s.label} · ${t.label}`, group: "Settings", icon: t.icon, keywords: g.label });
    }
  }
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
