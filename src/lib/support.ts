/**
 * Where people go for help, in one client-safe place so the app's Help menu
 * and the docs point at the same URLs. No imports.
 */

const REPO = "https://github.com/Kandid-ai/AgentSDR";

export const SUPPORT_LINKS = {
  docs: "https://docs.agentsdr.ai",
  featureRequest: `${REPO}/issues/new?template=feature_request.yml`,
  community: `${REPO}/discussions`,
  security: `${REPO}/security/advisories/new`,
} as const;

/**
 * The pages of our own docs (docs/*.mdx, served at SUPPORT_LINKS.docs) the
 * app links to, optionally with a section anchor (Mintlify slugifies the
 * heading). Listed here so a link cannot point at a page that does not
 * exist: support.test.ts checks every entry against docs/.
 */
export const DOCS_PAGES = [
  "email/connect#add-a-mailbox",
  "integrations/google-workspace",
  "integrations/unipile",
  "integrations/cloudflare-r2",
  "linkedin/accounts#add-a-linkedin-account",
  "whatsapp/accounts",
  "whatsapp/accounts#link-a-number",
  "whatsapp/calling#what-you-need",
  "whatsapp/calling#install-the-extension",
  "whatsapp/calling#update-the-extension",
  "whatsapp/calling#self-hosted-agentsdr",
  "integrations/openrouter#set-it-up",
  "integrations/enrichment-providers#connect-a-provider-account",
] as const;

export type DocsPage = (typeof DOCS_PAGES)[number];

/** The public URL of one of our docs pages, e.g. `docsPageUrl("integrations/unipile")`. */
export function docsPageUrl(page: DocsPage): string {
  return `${SUPPORT_LINKS.docs}/${page}`;
}

/**
 * The bug form, with its `version` field prefilled (GitHub issue forms read a
 * query param named after the field id). Only the app version goes in the
 * link: never the page, the person or their organization.
 */
export function bugReportUrl(version: string | undefined): string {
  const url = new URL(`${REPO}/issues/new`);
  url.searchParams.set("template", "bug_report.yml");
  if (version) url.searchParams.set("version", version);
  return url.toString();
}

/** package.json's version, inlined at build time by next.config.ts (env.NEXT_PUBLIC_APP_VERSION). */
export const APP_VERSION: string | undefined = process.env.NEXT_PUBLIC_APP_VERSION;
