import { pgTable, text, numeric, bigint, boolean } from "drizzle-orm/pg-core";

// Brand qualification pipeline tables (campaigns, targeted_domains, qualification_jobs).
export * from "./qualification/schema";

// Canonical CRM workflow, classification, sequence, and conversation tables.
export * from "./crm/schema";

// Master Inbox and inbound-delivery diagnostics.
export * from "./inbox/schema";

// Outreach sending tables (mailboxes, campaigns, leads, emails, suppression list).
export * from "./outreach/schema";

// Enrichment grid tables (grid_tables, grid_columns, grid_rows, grid_jobs, ...).
export * from "./grid/schema";

// WhatsApp calls placed from the app and their recordings (call_sessions).
export * from "./calls/schema";

// WhatsApp messaging through Unipile: linked numbers, chats, messages.
export * from "./whatsapp/schema";

// Instagram direct messages through Unipile (src/lib/instagram/).
export * from "./instagram/schema";

// Inquiry intake: website-form webhooks and Instagram inquiries (src/lib/intake/).
export * from "./intake/schema";

// Optional per-organization features, all off by default (src/lib/features/).
export * from "./features/schema";
export * from "./apify/schema";
export * from "./treg/schema";
export * from "./tavily/schema";
export * from "./brightdata/schema";
export * from "./tinyfish/schema";
export * from "./quota/schema";
export * from "./browser/schema";
// Connected-browser research: a person's own Chrome and the commands queued for it.
export * from "./browser/connected/schema";
// Browser outreach: contact routes, sender accounts and the send queue (src/lib/browserOutreach/).
export * from "./browserOutreach/schema";
export * from "./activity/schema";

// Web research about imported companies (src/lib/research/).
export * from "./research/schema";
// Research sources (Hacker News, Stack Exchange; the Reddit approval record).
export * from "./research/sourcesSchema";

// The owner's assistant: chat, business profile, audiences, jobs, outreach runs (src/lib/assistant/).
export * from "./assistant/schema";

// Sending rules per organization and channel (src/lib/channels/rules.ts).
export * from "./channels/schema";

// Managed SaaS: platform operators, default provider credentials, Included / My own choices (src/lib/managed/).
export * from "./managed/schema";
// Unipile account ownership and the hosted-auth links the server minted (src/lib/unipile/).
export * from "./unipile/schema";

// The in-process scheduler's slot claims (src/lib/scheduler/), platform-wide.
export * from "./scheduler/schema";

// Better Auth: users, sessions, accounts, verifications, organizations,
// members, invitations, teams, team_members.
export * from "./auth/schema";

// The lead database (people, companies, entity_columns, import_runs).
//
// These tables are deliberately NOT in OWNED_TABLES: people/companies gain
// columns at runtime, so the definitions here are structurally incomplete by
// design and drizzle-kit must never diff them. See src/lib/leads/schema.ts.
export * from "./leads/schema";

export const domains = pgTable("domains", {
  domain: text("domain").primaryKey(),
  merchantName: text("merchant_name"),
  title: text("title"),
  categories: text("categories"),
  countryCode: text("country_code"),
  annualSales: numeric("annual_sales"),
  estimatedYearlySales: text("estimated_yearly_sales"),
  estimatedMonthlySales: text("estimated_monthly_sales"),
  rank: bigint("rank", { mode: "number" }),
  platformRank: bigint("platform_rank", { mode: "number" }),
  platform: text("platform"),
  employeeCount: bigint("employee_count", { mode: "number" }),
  region: text("region"),
  subregion: text("subregion"),
  city: text("city"),
  state: text("state"),
  status: text("status"),
  description: text("description"),
  domainUrl: text("domain_url"),
  combinedFollowers: bigint("combined_followers", { mode: "number" }),
  combinedReviews: bigint("combined_reviews", { mode: "number" }),
  productsSold: bigint("products_sold", { mode: "number" }),
  installedAppsCount: bigint("installed_apps_count", { mode: "number" }),
  created: text("created"),
  currency: text("currency"),
  languageCode: text("language_code"),
  headless: boolean("headless"),
  tags: text("tags"),
});

export const cleanDomains = pgTable("clean_domains", {
  domain: text("domain").primaryKey(),
  merchantName: text("merchant_name"),
  platform: text("platform"),
  rank: bigint("rank", { mode: "number" }),
  countryCode: text("country_code"),
  annualSales: numeric("annual_sales"),
  categories: text("categories"),
  c1: text("c1"),
  c2: text("c2"),
  c3: text("c3"),
  installedApps: text("installed_apps"),
  installedAppsNames: text("installed_apps_names"),
  installedAppsArray: text("installed_apps_array").array(),
  emails: text("emails"),
  phones: text("phones"),
});
