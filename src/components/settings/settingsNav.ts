import {
  RiBookOpenLine,
  RiCpuLine,
  RiDashboard3Line,
  RiKey2Line,
  RiGroupLine,
  RiInstagramLine,
  RiTeamLine,
  RiLayoutColumnLine,
  RiLinkedinBoxLine,
  RiMailLine,
  RiPlugLine,
  RiPaletteLine,
  RiPriceTag3Line,
  RiPuzzleLine,
  RiQuestionAnswerLine,
  RiQuillPenLine,
  RiSearchEyeLine,
  RiStore2Line,
  RiTimeLine,
  RiWhatsappLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import type { FeatureKey, FeatureState } from "@/lib/features/catalog";

export type SettingsTab = { href: string; label: string; icon: RemixiconComponentType };

/**
 * A row in the settings rail. With `tabs`, it opens the first and stays
 * active on any of them. With `feature`, it shows only while that optional
 * feature (src/lib/features/catalog.ts) is on for the organization.
 */
export type SettingsNavItem = SettingsTab & { tabs?: SettingsTab[]; feature?: FeatureKey };

/** Every page a row covers: itself, or its tabs. */
export function itemPages(item: SettingsNavItem): SettingsTab[] {
  return item.tabs ?? [item];
}

/**
 * The rail as the organization sees it: rows behind an optional feature only
 * while it is on. Until the features are known (`null`) they are left out,
 * so an organization without them sees exactly the rail it always had.
 */
export function visibleSettingsNav(features: FeatureState | null): typeof SETTINGS_NAV {
  return SETTINGS_NAV
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.feature || features?.[item.feature] === true) }))
    .filter((group) => group.items.length > 0);
}

/**
 * Every settings screen in the app, in five groups: what the assistant knows
 * about the business, who works in it and what the plan includes; the
 * accounts it sends from; how many new people it may contact a day; how far
 * one request researches and spends; and the advanced extras, among them the
 * technical connections for a workspace that uses its own providers. Each screen is its
 * own route under /settings and is listed once; the pages they replaced
 * redirect here (next.config.ts, and /settings/organization → /settings/business).
 */
export const SETTINGS_NAV: { label: string; items: SettingsNavItem[] }[] = [
  {
    label: "Your business",
    items: [
      { href: "/settings/business", label: "Business profile", icon: RiStore2Line },
      { href: "/settings/members", label: "Members", icon: RiGroupLine },
      { href: "/settings/teams", label: "Teams", icon: RiTeamLine },
      { href: "/settings/instructions", label: "Instructions", icon: RiQuillPenLine },
      { href: "/settings/knowledge", label: "Knowledge", icon: RiBookOpenLine },
      // What is included with the workspace and what is left of it (src/lib/managed/).
      { href: "/settings/usage", label: "Plan & usage", icon: RiDashboard3Line },
    ],
  },
  // The accounts a workspace sends from. The technical connections they run
  // on (Unipile, Google Workspace, the AI provider) are under Advanced → Use
  // your own providers: AI and account connections are included by default.
  {
    label: "Connected accounts",
    items: [
      { href: "/settings/email-accounts", label: "Email", icon: RiMailLine },
      { href: "/settings/linkedin-accounts", label: "LinkedIn", icon: RiLinkedinBoxLine },
      {
        href: "/settings/whatsapp-accounts",
        label: "WhatsApp",
        icon: RiWhatsappLine,
        tabs: [
          { href: "/settings/whatsapp-accounts", label: "Numbers", icon: RiWhatsappLine },
          { href: "/settings/whatsapp-connection", label: "Integrations", icon: RiPlugLine },
        ],
      },
      // Only for organizations that turned Instagram messages on.
      { href: "/settings/instagram-accounts", label: "Instagram", icon: RiInstagramLine, feature: "instagram" },
    ],
  },
  // The one sending input: the daily lead limit (src/lib/channels/rules.ts,
  // GENERAL_RULE_PAGES.sending). Sending is always on, and each channel's
  // pacing is automatic, so there are no per-channel rules pages; their old
  // addresses redirect here (src/lib/nav/legacyRoutes.ts).
  {
    label: "Sending & automation",
    items: [{ href: "/settings/sending", label: "Daily lead limit", icon: RiTimeLine }],
  },
  {
    label: "Research & budget",
    items: [{ href: "/settings/research", label: "Lead research", icon: RiSearchEyeLine }],
  },
  {
    label: "Advanced",
    items: [
      {
        href: "/settings/providers",
        label: "Use your own providers",
        icon: RiKey2Line,
        tabs: [
          { href: "/settings/providers", label: "Included or own", icon: RiKey2Line },
          { href: "/settings/ai", label: "AI provider", icon: RiCpuLine },
          { href: "/settings/linkedin-connection", label: "Unipile", icon: RiPlugLine },
          { href: "/settings/email-connection", label: "Google Workspace", icon: RiMailLine },
        ],
      },
      { href: "/settings/advanced", label: "Providers & features", icon: RiPuzzleLine },
      { href: "/settings/lead-categories", label: "Lead categories", icon: RiPriceTag3Line },
      { href: "/settings/columns", label: "Lead columns", icon: RiLayoutColumnLine },
      { href: "/settings/inquiries", label: "Inquiries", icon: RiQuestionAnswerLine, feature: "inquiry_intake" },
      { href: "/settings/appearance", label: "Appearance", icon: RiPaletteLine },
    ],
  },
];

/** Where "Settings" opens: Your business → Business profile. */
export const SETTINGS_HOME = SETTINGS_NAV[0].items[0].href;
