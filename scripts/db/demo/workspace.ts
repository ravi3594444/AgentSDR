/**
 * The demo's workspace: Tables (folders, workbooks, sheets with finished
 * enrichment runs) and Prospecting (the global storefront dataset plus the
 * qualification campaigns that were run over it).
 *
 * Nothing here calls a provider. Enrichment, AI, HTTP and formula cells are
 * written the way the grid worker leaves them after a successful run: the
 * value, `cellMeta` {status: "success", outcome, provider, costCents, runAt}
 * and an audit row in grid_cell_runs. No grid_jobs row exists, so the grid
 * never starts polling, and no qualification job is left running, so the
 * campaign page never restarts one.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getByokSettings, saveByokSettings } from "@/lib/ai/byok";
import {
  gridCellRuns,
  gridColumns,
  gridFolders,
  gridProviderCredentials,
  gridProviders,
  gridRows,
  gridTables,
  gridWorkbooks,
} from "@/lib/grid/schema";
import type {
  AiConfig,
  AiOutputConfig,
  CellMeta,
  ColumnConfig,
  ColumnType,
  EnrichmentConfig,
  FormulaConfig,
  HttpConfig,
  IntegrationOutputConfig,
  SelectOption,
  TableView,
} from "@/lib/grid/types";
import { encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { cleanDomains } from "@/lib/schema";
import { buildApolloPeopleSearchUrl } from "@/lib/qualification/apolloLink";
import { campaigns, qualificationJobs, targetedDomains } from "@/lib/qualification/schema";
import type { ApolloLeadDebugTrace, ApolloSearchDebugTrace, QualificationDebugTrace } from "@/lib/qualification/types";
import appsData from "@/data/apps.json";
import categoriesData from "@/data/categories.json";
import { TEAM } from "./content";
import { HOUR, MINUTE, addMs, count, daysAgo, workTime, type DemoContext } from "./context";


const lcFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const slugify = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "");
const round = (n: number, step: number) => Math.round(n / step) * step;

// ---------------------------------------------------------------------------
// Grid plumbing
// ---------------------------------------------------------------------------

type ColDef = {
  key: string;
  name: string;
  type: ColumnType;
  config?: ColumnConfig;
  dependsOn?: string[];
  autoRun?: boolean;
};

type SheetRow = { cells: Record<string, unknown>; meta: Record<string, CellMeta>; createdAt: Date; updatedAt: Date };

type RunRecord = {
  rowIndex: number;
  columnKey: string;
  provider: string;
  outcome: "hit" | "miss";
  costCents: number;
  latencyMs: number;
  request: unknown;
  response: unknown;
  createdAt: Date;
};

async function createSheet(input: {
  workbookId: string;
  name: string;
  position: number;
  description?: string;
  columns: ColDef[];
  view?: TableView;
  createdAt: Date;
  updatedAt: Date;
}): Promise<string> {
  const [table] = await db
    .insert(gridTables)
    .values({
      organizationId: currentOrg,
      workbookId: input.workbookId,
      name: input.name,
      position: input.position,
      description: input.description ?? null,
      autoRun: true,
      view: input.view ?? {},
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning({ id: gridTables.id });
  await db.insert(gridColumns).values(
    input.columns.map((c, i) => ({
      tableId: table.id,
      key: c.key,
      name: c.name,
      type: c.type,
      config: c.config ?? {},
      dependsOn: c.dependsOn ?? [],
      position: i + 1,
      autoRun: c.autoRun ?? false,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })),
  );
  return table.id;
}

async function insertSheetRows(tableId: string, rows: SheetRow[], runs: RunRecord[]): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const inserted = await db
      .insert(gridRows)
      .values(
        chunk.map((r, j) => ({
          tableId,
          position: i + j + 1,
          cells: r.cells,
          cellMeta: r.meta,
          version: sql<number>`nextval('grid_row_version_seq')`,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      )
      .returning({ id: gridRows.id });
    ids.push(...inserted.map((x) => x.id));
  }
  for (let i = 0; i < runs.length; i += 200) {
    await db.insert(gridCellRuns).values(
      runs.slice(i, i + 200).map((r) => ({
        tableId,
        rowId: ids[r.rowIndex],
        columnKey: r.columnKey,
        provider: r.provider,
        outcome: r.outcome,
        costCents: String(r.costCents),
        latencyMs: r.latencyMs,
        request: r.request,
        response: r.response,
        createdAt: r.createdAt,
      })),
    );
  }
}

const option = (value: string, color: string): SelectOption => ({ value, label: value, color });

/** A finished run's metadata, as completeJob() writes it. */
const doneMeta = (runAt: Date, provider: string | undefined, costCents: number, outcome: "hit" | "miss" = "hit"): CellMeta => ({
  status: "success",
  outcome,
  ...(provider ? { provider } : {}),
  costCents,
  runAt: runAt.toISOString(),
});

let currentOrg = "";

// ---------------------------------------------------------------------------
// Copy for the account research sheet
// ---------------------------------------------------------------------------

const WHEN = ["this spring", "in March", "last quarter", "over the summer", "earlier this year", "last autumn", "in May", "in June"];

const WHY_BY_FUNDING: Record<string, ((c: Account, w: string) => string)[]> = {
  Seed: [
    (c, w) => `Closed its seed ${w} and is ${c.employees} people, still hiring its first sales roles, so outbound is probably founder-led right now.`,
    (c) => `Only ${c.employees} people but already selling ${lcFirst(c.blurb)}; teams this small usually want pipeline before the next raise.`,
  ],
  "Series A": [
    (c, w) => `Series A ${w} with the team at ${c.employees}; the board will expect a repeatable pipeline motion before a B.`,
    (c) => `Two SDR openings on LinkedIn since the Series A, a sign they are building outbound from scratch in ${c.hq.split(",")[0]}.`,
    (c, w) => `Raised ${w} and is selling ${lcFirst(c.blurb)}; at ${c.employees} people the first outbound hires are usually next.`,
  ],
  "Series B": [
    (c, w) => `Raised a Series B ${w} and is scaling past ${c.employees} people; ${lcFirst(c.blurb)} is a considered purchase, so pipeline coverage is the new bottleneck.`,
    (c) => `New head of sales joined the ${c.hq.split(",")[0]} team this year, usually the moment tooling and process get reviewed.`,
    (c, w) => `Series B ${w}; hiring across sales and CS (${c.employees} people and growing) and needs outbound that scales without more headcount.`,
  ],
  "Series C": [
    (c, w) => `Series C ${w} with ${c.employees} people; now expanding into new regions, which means new pipeline outside the founder network.`,
    (c) => `Running separate SDR teams per segment at ${c.employees} people, a good moment to standardise how those teams prospect.`,
  ],
  Public: [
    (c) => `Public company with about ${c.employees.toLocaleString("en-US")} people; at that size several SDR teams usually prospect in parallel, so a shared view of who to contact pays off quickly.`,
    (c) => `Large, listed and selling ${lcFirst(c.blurb)}; new-logo teams this big tend to measure SDR productivity closely, a natural opening for better prioritisation.`,
  ],
  Private: [
    (c) => `Late-stage private company with about ${c.employees.toLocaleString("en-US")} people; scaling outbound across regions without adding headcount is the usual priority at this stage.`,
    (c) => `Private and growing, selling ${lcFirst(c.blurb)}; teams like this usually run outbound per segment, which makes consistent account research worth standardising.`,
  ],
  "PE-backed": [
    (c) => `Owned by a private-equity sponsor with about ${c.employees.toLocaleString("en-US")} people; efficiency targets usually make cost per meeting a board-level number.`,
    (c) => `Sponsor-backed and selling ${lcFirst(c.blurb)}; replacing manual prospecting with automation is typically an easy case to make here.`,
  ],
  Bootstrapped: [
    (c) => `Profitable and bootstrapped for ${new Date().getFullYear() - c.founded} years; referrals have flattened and outbound is the next lever.`,
    (c) => `Self-funded and ${c.employees} people strong; growth has come from word of mouth, but the market for ${lcFirst(c.blurb)} is getting crowded.`,
  ],
};

const ANGLE_BY_INDUSTRY: Record<string, string[]> = {
  "B2B SaaS": ["Lead with how similar SaaS teams cut research time per account, then offer a 15-minute walkthrough.", "Open on pipeline coverage per rep and ask who owns outbound today."],
  Fintech: ["Open with compliant outreach at scale and mention that every send is logged.", "Lead with speed to first meeting for new enterprise segments."],
  Healthtech: ["Lead with clinic-operations credibility and keep the first email short and plain.", "Reference a peer care-coordination company and ask about referral sources."],
  Logistics: ["Open on lane-by-lane prospecting and how a rep covers more shippers each week.", "Ask who handles seasonal ramp-up outreach."],
  "E-commerce": ["Lead with wholesale buyers and how fast a rep can cover a new retailer list.", "Open on the holiday calendar and the cost of starting late."],
  Cybersecurity: ["Lead with trust: security review is already done, then ask about their mid-market motion.", "Open with the partner-sourced pipeline gap."],
  "Developer tools": ["Open on turning product-qualified signups into booked calls without feeling salesy.", "Lead with how a small team follows up on every team-plan trial."],
  "HR tech": ["Lead with Q4 pipeline for a January buying window.", "Open on how SDRs personalise by headcount and hiring plans."],
  Martech: ["Open with the competitor-acquisition window and offer a side-by-side.", "Lead with sales-assisted motion: who qualifies inbound today?"],
  Edtech: ["Lead with district shortlists and the cost of missing the autumn window.", "Ask who owns partnerships outreach."],
  Proptech: ["Open on property-manager lists by portfolio size.", "Lead with a customer in the same unit-count band."],
  "Climate tech": ["Open on incentives timing and quote-to-install speed.", "Lead with steady lead flow to smooth a lumpy pipeline."],
  Manufacturing: ["Lead with post-show follow-up and a faster path to RFQs.", "Open on the second plant and who is selling the new capacity."],
  Agency: ["Open on new-business consistency after a lost retainer; keep it empathetic.", "Lead with a case study from a similar-sized agency."],
  Insurtech: ["Open on carrier and broker outreach before January renewals.", "Lead with state-by-state launch support."],
  "Legal tech": ["Lead with the 'do more with less' angle for in-house teams.", "Open with the law-firm pilot and ask how they will source the next five."],
};

const MORE_ANGLES: Record<string, string[]> = {
  "B2B SaaS": ["Ask how reps decide which accounts to touch first and offer the ICP scoring sheet as a trade.", "Lead with reply handling: most SaaS teams lose warm replies in the inbox.", "Open with a pipeline-per-rep benchmark from teams their size.", "Reference their pricing change and ask who owns the new sales motion."],
  Fintech: ["Open with a short note on audit trails for every automated message.", "Lead with LinkedIn plus email together for compliance-heavy buyers.", "Ask how they source banking-partner introductions today.", "Reference the compliance hires and offer a security review pack."],
  Healthtech: ["Open with a plain-language note on how clinic ops teams book meetings faster.", "Ask how they handle referral partners and offer a shared tracking sheet.", "Lead with HIPAA-safe handling of lead data, then the demo.", "Reference the health-system win and ask who sells into the next one."],
  Logistics: ["Open with a lane list built from public shipper data.", "Lead with Q4 capacity and why starting in October beats November.", "Ask how brokers split outbound between phone and email.", "Offer a sample list of shippers near the new hub."],
  "E-commerce": ["Open with a retailer shortlist for their wholesale launch.", "Lead with buyer calendars and the cost of a late holiday pitch.", "Ask who owns wholesale outreach and offer a template set.", "Reference their DTC strength and propose a wholesale test."],
  Cybersecurity: ["Lead with the SOC 2 milestone and a mid-market list of buyers who care.", "Open with partner-sourced pipeline and a co-selling template.", "Ask how they qualify inbound from security questionnaires.", "Offer a teardown of their current outbound sequence."],
  "Developer tools": ["Open with a note on following up on every team-plan trial within an hour.", "Lead with open-source contributors who work at target accounts.", "Ask who owns the free-to-paid handoff.", "Reference the team plan launch and offer a trial-signal workflow."],
  "HR tech": ["Open with a January-window plan: who to contact in Q4 and with what.", "Lead with headcount-based personalisation for HR buyers.", "Ask how they reach CHROs versus HR ops managers.", "Offer webinar-attendee follow-up templates."],
  Martech: ["Open with a side-by-side against the acquired competitor.", "Lead with who qualifies inbound leads now that sales is involved.", "Ask how they hand product signups to reps.", "Offer a switching checklist for the competitor's customers."],
  Edtech: ["Open with a district shortlist built from public board agendas.", "Ask who runs partnerships outreach and offer a calendar of budget cycles.", "Lead with the cost of missing the autumn evaluation window.", "Reference the K-12 hire and propose a pilot-follow-up sequence."],
  Proptech: ["Open with property managers grouped by portfolio size.", "Lead with a customer in the same unit-count band.", "Ask how they find portfolio owners beyond the big names.", "Reference the large portfolio win and offer a lookalike list."],
  "Climate tech": ["Open with incentive deadlines and which installers they affect.", "Lead with how steady outbound smooths lumpy project pipeline.", "Ask who qualifies commercial leads before quotes go out.", "Offer a list of facilities teams in their service area."],
  Manufacturing: ["Open with a post-trade-show follow-up cadence.", "Lead with who needs the extra capacity from the second plant.", "Ask how RFQs are triaged and offer a faster path.", "Reference the plant opening and propose a regional list."],
  Agency: ["Open with a quick, empathetic note on rebuilding new-business after a lost retainer.", "Lead with a case study from a similar-sized agency.", "Ask how the new growth lead plans to source pipeline.", "Offer a lookalike client list based on their best retainers."],
  Insurtech: ["Open with broker lists for the new states they filed in.", "Lead with renewal timing and a Q4 outreach plan.", "Ask how carrier introductions happen today.", "Offer a compliance-friendly sequence for state launches."],
  "Legal tech": ["Open with general counsel lists by company size and industry.", "Lead with how law-firm pilots turn into references.", "Ask who owns in-house-legal outreach.", "Offer a short sequence tuned to the budget memo angle."],
};
for (const [k, v] of Object.entries(MORE_ANGLES)) ANGLE_BY_INDUSTRY[k].push(...v);

const STACK = {
  crm: ["HubSpot", "Salesforce", "Pipedrive", "Close"],
  engage: ["Outreach", "Salesloft", "Apollo", "Instantly", "Lemlist"],
  analytics: ["Segment", "Mixpanel", "Amplitude", "Google Analytics 4", "Heap"],
  infra: ["AWS", "Google Cloud", "Vercel", "Cloudflare", "Azure"],
  support: ["Intercom", "Zendesk", "Front", "Help Scout"],
};

type Account = DemoContext["companies"][number];

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

async function seedProviders(ctx: DemoContext): Promise<{ apollo: string; openrouter: string }> {
  const at = daysAgo(ctx, 95);
  const [apollo] = await db
    .insert(gridProviders)
    .values({
      organizationId: ctx.organizationId,
      key: `apollo-${randomUUID()}`,
      name: "Northwind Apollo",
      config: { integrationKey: "apollo", verification: { status: "verified", verifiedAt: at.toISOString() } },
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: gridProviders.id });
  await db.insert(gridProviderCredentials).values({ providerId: apollo.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "demo-apollo-key" }) });

  const [openrouter] = await db
    .insert(gridProviders)
    .values({
      organizationId: ctx.organizationId,
      key: `ai-openrouter-${randomUUID()}`,
      name: "Northwind OpenRouter",
      config: { aiProviderKey: "openrouter", verification: { status: "verified", verifiedAt: at.toISOString() } },
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: gridProviders.id });
  await db
    .insert(gridProviderCredentials)
    .values({ providerId: openrouter.id, encryptedPayload: encryptIntegrationCredentials({ apiKey: "demo-openrouter-key", managementKey: "demo-openrouter-management-key" }) });

  const settings = await getByokSettings();
  if (!settings.connectionId) {
    await saveByokSettings({
      connectionId: openrouter.id,
      providers: ["anthropic", "google"],
      modelsByProvider: { anthropic: [AI_MODEL, "anthropic/claude-haiku-4.5"], google: ["google/gemini-2.5-flash"] },
      defaultModel: { provider: "anthropic", modelId: AI_MODEL },
      transcriptionModel: { provider: "google", modelId: "google/gemini-2.5-flash" },
      researchModel: null,
      researchDailyLimit: 25,
      byokOnlyConfirmed: true,
    });
  }
  count(ctx, "integration accounts for Tables (Apollo, OpenRouter)", 2);
  return { apollo: apollo.id, openrouter: openrouter.id };
}

const AI_MODEL = "anthropic/claude-sonnet-4.5";

function icpScore(ctx: DemoContext, c: Account): number {
  const fit: Record<string, number> = {
    "B2B SaaS": 12, Fintech: 8, "Developer tools": 7, Martech: 10, "HR tech": 8, Cybersecurity: 6, Healthtech: 3, "Legal tech": 5,
    Insurtech: 4, Edtech: 2, Proptech: 4, Logistics: 1, "E-commerce": 0, "Climate tech": -2, Manufacturing: -5, Agency: 6,
  };
  const size = c.employees >= 100 && c.employees <= 700 ? 14 : c.employees > 700 ? 5 : c.employees >= 40 ? 6 : -4;
  const funding: Record<string, number> = { "Series B": 9, "Series A": 7, "Series C": 6, Private: 5, Seed: 2, "PE-backed": 3, Public: 1, Bootstrapped: 0 };
  const raw = 52 + (fit[c.industry] ?? 0) + size + (funding[c.funding] ?? 0) + ctx.rand.int(-9, 13);
  return Math.max(28, Math.min(97, raw));
}

const seenAngles = new Set<string>();

function pickAngle(ctx: DemoContext, c: Account): string {
  const pool = ANGLE_BY_INDUSTRY[c.industry];
  const fresh = pool.filter((a) => !seenAngles.has(a));
  const angle = ctx.rand.pick(fresh.length ? fresh : pool);
  seenAngles.add(angle);
  return angle;
}

function whyNow(ctx: DemoContext, c: Account, seen: Set<string>): { why: string; angle: string } {
  const pool = WHY_BY_FUNDING[c.funding] ?? WHY_BY_FUNDING["Series B"];
  for (let attempt = 0; attempt < 40; attempt++) {
    const why = ctx.rand.pick(pool)(c, ctx.rand.pick(WHEN));
    // Industry hooks stated invented facts ("hiring a RevOps manager right now"); the
    // accounts are real companies now, so the sentence stays general reasoning.
    if (!seen.has(why)) {
      seen.add(why);
      return { why, angle: pickAngle(ctx, c) };
    }
  }
  const why = `${c.name} is ${c.employees} people in ${c.hq.split(",")[0]} and has been growing steadily; outbound is the cheapest next lever.`;
  return { why, angle: pickAngle(ctx, c) };
}

function techStack(ctx: DemoContext): string {
  const parts = [ctx.rand.pick(STACK.crm)];
  if (ctx.rand.chance(0.6)) parts.push(ctx.rand.pick(STACK.engage));
  parts.push(ctx.rand.pick(STACK.analytics));
  if (ctx.rand.chance(0.7)) parts.push(ctx.rand.pick(STACK.infra));
  if (ctx.rand.chance(0.45)) parts.push(ctx.rand.pick(STACK.support));
  return [...new Set(parts)].join(" · ");
}

const STAGE_OPTIONS = [
  option("New", "gray"), option("Researching", "blue"), option("Contacted", "yellow"),
  option("Engaged", "orange"), option("Meeting booked", "green"), option("Not a fit", "red"),
];
const OWNERS = [TEAM.alex.first, TEAM.priya.first, TEAM.jordan.first, TEAM.sam.first, TEAM.lena.first];
const OWNER_OPTIONS = [option("Alex", "purple"), option("Priya", "blue"), option("Jordan", "green"), option("Sam", "orange"), option("Lena", "pink")];

function stageFor(ctx: DemoContext, icp: number): string {
  if (icp >= 85) return ctx.rand.weighted([["Researching", 1], ["Contacted", 3], ["Engaged", 3], ["Meeting booked", 3]] as const);
  if (icp >= 70) return ctx.rand.weighted([["New", 1], ["Researching", 3], ["Contacted", 4], ["Engaged", 2], ["Meeting booked", 1], ["Not a fit", 0.4]] as const);
  if (icp >= 55) return ctx.rand.weighted([["New", 4], ["Researching", 4], ["Contacted", 2], ["Not a fit", 1.5]] as const);
  return ctx.rand.weighted([["New", 3], ["Researching", 2], ["Not a fit", 4]] as const);
}

async function seedAccountsWorkbook(
  ctx: DemoContext,
  folderId: string,
  connections: { apollo: string; openrouter: string },
): Promise<{ accounts: Account[]; contactIds: Set<string> }> {
  const importedAt = workTime(ctx, 41);
  const lastTouched = workTime(ctx, 2);
  const [workbook] = await db
    .insert(gridWorkbooks)
    .values({
      organizationId: ctx.organizationId,
      name: "Q4 target accounts",
      description: "Accounts the team agreed to work this quarter, with research and the people to contact.",
      folderId,
      createdAt: importedAt,
      updatedAt: lastTouched,
    })
    .returning({ id: gridWorkbooks.id });

  const accounts = ctx.rand.shuffle(ctx.companies).slice(0, 60);
  const seenWhy = new Set<string>();
  seenAngles.clear();

  const stageOptions = { options: STAGE_OPTIONS };
  const aiConfig: AiConfig = {
    useCase: "content",
    providerKey: "openrouter",
    modelKey: AI_MODEL,
    upstreamProvider: "anthropic",
    connectionId: connections.openrouter,
    prompt:
      "You are a sales researcher at Northwind. Account: {{company}} ({{website}}), {{industry}}, {{employees}} employees, funding stage {{funding}}. " +
      "In one specific sentence say why this account is worth prioritising now, and suggest the angle for the first email.",
    outputFormat: "fields",
    outputs: [
      { key: "whyNow", name: "Why now", type: "text", description: "One specific sentence on timing." },
      { key: "suggestedAngle", name: "Suggested angle", type: "text", description: "How to open the first email." },
    ],
    outputColumns: { whyNow: "whyNow", suggestedAngle: "suggestedAngle" },
    maxTokens: 400,
  };
  const apolloCompany: EnrichmentConfig = {
    integrationKey: "apollo",
    actionKey: "enrich-company-by-domain",
    handlerKey: "apollo.enrichCompanyByDomain",
    inputs: { domain: { source: "column", columnKey: "website" } },
    outputs: { linkedinUrl: "companyLinkedin" },
    connectionId: connections.apollo,
  };
  const stackHttp: HttpConfig = {
    method: "GET",
    url: "https://api.stackscan.example/v1/technologies?domain={{website}}",
    responsePath: "data.summary",
    providerKey: "stackscan",
    costCents: 0.4,
  };
  const tierFormula: FormulaConfig = { expression: 'IF({{icp}} >= 80, "A", IF({{icp}} >= 60, "B", "C"))' };
  const aiOut = (outputKey: string): AiOutputConfig => ({ sourceColumnKey: "whyNowResearch", outputKey, valueType: "text" });
  const apolloOut: IntegrationOutputConfig = {
    integrationKey: "apollo",
    actionKey: "enrich-company-by-domain",
    sourceColumnKey: "enrichCompanyByDomain",
    outputKey: "linkedinUrl",
    valueType: "url",
  };

  const columns: ColDef[] = [
    { key: "company", name: "Company", type: "text" },
    { key: "website", name: "Website", type: "url" },
    { key: "industry", name: "Industry", type: "text" },
    { key: "employees", name: "Employees", type: "number" },
    { key: "hq", name: "HQ", type: "text" },
    { key: "funding", name: "Funding stage", type: "text" },
    { key: "icp", name: "ICP score", type: "number" },
    { key: "icpTier", name: "ICP tier", type: "formula", config: tierFormula, dependsOn: ["icp"], autoRun: true },
    { key: "stage", name: "Stage", type: "select", config: stageOptions },
    { key: "owner", name: "Owner", type: "select", config: { options: OWNER_OPTIONS } },
    { key: "enrichCompanyByDomain", name: "Enrich company by domain", type: "enrichment", config: apolloCompany, dependsOn: ["website"], autoRun: true },
    { key: "companyLinkedin", name: "Company LinkedIn URL", type: "integration_output", config: apolloOut, dependsOn: ["enrichCompanyByDomain"] },
    { key: "techStack", name: "Tech stack", type: "http", config: stackHttp, dependsOn: ["website"], autoRun: true },
    {
      key: "whyNowResearch", name: "Why now research", type: "ai", config: aiConfig,
      dependsOn: ["company", "website", "industry", "employees", "funding"], autoRun: true,
    },
    { key: "whyNow", name: "Why now", type: "ai_output", config: aiOut("whyNow"), dependsOn: ["whyNowResearch"] },
    { key: "suggestedAngle", name: "Suggested angle", type: "ai_output", config: aiOut("suggestedAngle"), dependsOn: ["whyNowResearch"] },
  ];

  const accountsTable = await createSheet({
    workbookId: workbook.id,
    name: "Accounts",
    position: 1,
    description: "One row per target account.",
    columns,
    view: { pinnedColumns: ["company"], sorts: [{ columnKey: "icp", direction: "desc" }] },
    createdAt: importedAt,
    updatedAt: lastTouched,
  });

  // Each runnable column was added in turn, a while after the import.
  const apolloStart = addMs(importedAt, 6 * MINUTE);
  const stackStart = addMs(importedAt, 31 * MINUTE);
  const aiStart = addMs(importedAt, 58 * MINUTE);
  const rows: SheetRow[] = [];
  const runs: RunRecord[] = [];
  accounts.forEach((c, i) => {
    const icp = icpScore(ctx, c);
    const stage = stageFor(ctx, icp);
    const owner = ctx.rand.weighted([["Alex", 2], ["Priya", 3], ["Jordan", 3], ["Sam", 3], ["Lena", 3]] as const);
    const apolloAt = addMs(apolloStart, i * ctx.rand.int(2500, 6500));
    const stackAt = addMs(stackStart, i * ctx.rand.int(1500, 4500));
    const aiAt = addMs(aiStart, i * ctx.rand.int(5000, 12000));
    const website = `https://${c.domain}`;
    const { why, angle } = whyNow(ctx, c, seenWhy);
    const stack = techStack(ctx);
    const linkedinMiss = ctx.rand.chance(0.07);
    const cells: Record<string, unknown> = {
      company: c.name, website, industry: c.industry, employees: c.employees, hq: c.hq, funding: c.funding,
      icp, icpTier: icp >= 80 ? "A" : icp >= 60 ? "B" : "C", stage, owner,
      enrichCompanyByDomain: linkedinMiss ? null : "Completed",
      ...(linkedinMiss ? {} : { companyLinkedin: `https://www.linkedin.com/company/${c.slug}` }),
      techStack: stack,
      whyNowResearch: "Completed", whyNow: why, suggestedAngle: angle,
    };
    const aiCost = Math.round((0.14 + ctx.rand.next() * 0.3) * 1000) / 1000;
    const meta: Record<string, CellMeta> = {
      icpTier: doneMeta(addMs(importedAt, 90_000), undefined, 0),
      enrichCompanyByDomain: doneMeta(apolloAt, "apollo", linkedinMiss ? 0 : 1, linkedinMiss ? "miss" : "hit"),
      techStack: doneMeta(stackAt, "stackscan", 0.4),
      whyNowResearch: doneMeta(aiAt, `openrouter/${AI_MODEL}@anthropic`, aiCost),
      whyNow: doneMeta(aiAt, `openrouter/${AI_MODEL}@anthropic`, aiCost),
      suggestedAngle: doneMeta(aiAt, `openrouter/${AI_MODEL}@anthropic`, aiCost),
    };
    if (!linkedinMiss) meta.companyLinkedin = meta.enrichCompanyByDomain;
    const edited = ctx.rand.chance(0.45) ? workTime(ctx, ctx.rand.int(1, 30)) : aiAt;
    const updatedAt = new Date(Math.max(edited.getTime(), aiAt.getTime()));
    rows.push({ cells, meta, createdAt: importedAt, updatedAt });
    runs.push(
      {
        rowIndex: i, columnKey: "enrichCompanyByDomain", provider: "apollo", outcome: linkedinMiss ? "miss" : "hit", costCents: linkedinMiss ? 0 : 1,
        latencyMs: ctx.rand.int(380, 1400), request: { domain: c.domain },
        response: linkedinMiss ? { organization: null } : { organization: { name: c.name, primary_domain: c.domain, linkedin_url: `https://www.linkedin.com/company/${c.slug}`, estimated_num_employees: c.employees } },
        createdAt: apolloAt,
      },
      {
        rowIndex: i, columnKey: "techStack", provider: "stackscan", outcome: "hit", costCents: 0.4, latencyMs: ctx.rand.int(220, 900),
        request: { method: "GET", url: `https://api.stackscan.example/v1/technologies?domain=${c.domain}` },
        response: { data: { summary: stack, count: stack.split(" · ").length } },
        createdAt: stackAt,
      },
      {
        rowIndex: i, columnKey: "whyNowResearch", provider: `openrouter/${AI_MODEL}@anthropic`, outcome: "hit", costCents: aiCost,
        latencyMs: ctx.rand.int(1800, 4600),
        request: { model: AI_MODEL, prompt: `Account: ${c.name} (${website}), ${c.industry}, ${c.employees} employees, funding stage ${c.funding}.` },
        response: { whyNow: why, suggestedAngle: angle },
        createdAt: aiAt,
      },
    );
  });
  await insertSheetRows(accountsTable, rows, runs);

  // -- Contacts -------------------------------------------------------------
  const accountIds = new Set(accounts.map((c) => c.id));
  const atAccounts = ctx.people.filter((p) => accountIds.has(p.company.id));
  const unassigned = new Set(ctx.pools.unassigned.map((p) => p.id));
  const ordered = [...atAccounts.filter((p) => unassigned.has(p.id)), ...ctx.rand.shuffle(atAccounts.filter((p) => !unassigned.has(p.id)))];
  const contacts = ctx.rand.shuffle(ordered.slice(0, 80));

  const findPerson: EnrichmentConfig = {
    integrationKey: "apollo",
    actionKey: "find-person-by-email",
    handlerKey: "apollo.findPersonByEmail",
    inputs: { email: { source: "column", columnKey: "email" } },
    outputs: { jobTitle: "jobTitle", linkedinUrl: "linkedinUrl" },
    connectionId: connections.apollo,
  };
  const contactsAt = addMs(importedAt, 3 * HOUR);
  const contactColumns: ColDef[] = [
    { key: "name", name: "Name", type: "text" },
    { key: "firstName", name: "First name", type: "formula", config: { expression: '{{name}}.split(" ")[0]' } satisfies FormulaConfig, dependsOn: ["name"], autoRun: true },
    { key: "company", name: "Company", type: "text" },
    { key: "email", name: "Email", type: "email" },
    {
      key: "emailStatus", name: "Email status", type: "select",
      config: { options: [option("Verified", "green"), option("Catch-all", "yellow"), option("Unknown", "gray")] },
    },
    { key: "seniority", name: "Seniority", type: "select", config: { options: ["C-level", "VP", "Director", "Manager", "Founder"].map((s, i) => option(s, ["red", "purple", "blue", "gray", "orange"][i])) } },
    { key: "findPersonByEmail", name: "Find person by email", type: "enrichment", config: findPerson, dependsOn: ["email"], autoRun: true },
    { key: "jobTitle", name: "Job Title", type: "integration_output", config: { integrationKey: "apollo", actionKey: "find-person-by-email", sourceColumnKey: "findPersonByEmail", outputKey: "jobTitle", valueType: "text" } satisfies IntegrationOutputConfig, dependsOn: ["findPersonByEmail"] },
    { key: "linkedinUrl", name: "LinkedIn URL", type: "integration_output", config: { integrationKey: "apollo", actionKey: "find-person-by-email", sourceColumnKey: "findPersonByEmail", outputKey: "linkedinUrl", valueType: "url" } satisfies IntegrationOutputConfig, dependsOn: ["findPersonByEmail"] },
  ];
  const contactsTable = await createSheet({
    workbookId: workbook.id,
    name: "Contacts",
    position: 2,
    description: "Decision makers at the accounts, found and checked with Apollo.",
    columns: contactColumns,
    view: { pinnedColumns: ["name"] },
    createdAt: contactsAt,
    updatedAt: lastTouched,
  });
  const contactRows: SheetRow[] = [];
  const contactRuns: RunRecord[] = [];
  const apolloContactsStart = addMs(contactsAt, 12 * MINUTE);
  contacts.forEach((p, i) => {
    const at = addMs(apolloContactsStart, i * ctx.rand.int(2200, 5200));
    const miss = ctx.rand.chance(0.06);
    const status = ctx.rand.weighted([["Verified", 78], ["Catch-all", 15], ["Unknown", 7]] as const);
    const linkedin = `https://www.linkedin.com/in/${p.linkedinSlug}`;
    const cells: Record<string, unknown> = {
      name: p.fullName, firstName: p.firstName, company: p.company.name, email: p.email, emailStatus: status, seniority: p.seniority,
      findPersonByEmail: miss ? null : "Completed",
      ...(miss ? {} : { jobTitle: p.title, linkedinUrl: linkedin }),
    };
    const meta: Record<string, CellMeta> = {
      firstName: doneMeta(addMs(contactsAt, 60_000), undefined, 0),
      findPersonByEmail: doneMeta(at, "apollo", miss ? 0 : 1, miss ? "miss" : "hit"),
    };
    if (!miss) {
      meta.jobTitle = meta.findPersonByEmail;
      meta.linkedinUrl = meta.findPersonByEmail;
    }
    contactRows.push({ cells, meta, createdAt: contactsAt, updatedAt: ctx.rand.chance(0.3) ? workTime(ctx, ctx.rand.int(2, 25)) : at });
    contactRuns.push({
      rowIndex: i, columnKey: "findPersonByEmail", provider: "apollo", outcome: miss ? "miss" : "hit", costCents: miss ? 0 : 1,
      latencyMs: ctx.rand.int(420, 1500), request: { email: p.email },
      response: miss ? { person: null } : { person: { first_name: p.firstName, last_name: p.lastName, title: p.title, organization: { name: p.company.name }, linkedin_url: linkedin } },
      createdAt: at,
    });
  });
  // The person's updatedAt must not precede the run that wrote their cells.
  contactRows.forEach((r, i) => { if (r.updatedAt < contactRuns[i].createdAt) r.updatedAt = contactRuns[i].createdAt; });
  await insertSheetRows(contactsTable, contactRows, contactRuns);

  count(ctx, "Tables: accounts (enriched, AI researched)", accounts.length);
  count(ctx, "Tables: contacts", contacts.length);
  return { accounts, contactIds: new Set(contacts.map((p) => p.id)) };
}

const INBOUND_SOURCES: [string, string[]][] = [
  ["Demo request form", [
    "We are rebuilding our outbound motion for next year and want to see how the reply handling works.",
    "Looking to replace a patchwork of sequencers. Can someone walk us through it this week?",
    "Our SDRs spend half their day on research. Interested in the enrichment side.",
    "Evaluating three tools, yours came recommended by a peer. Pricing for about 12 seats?",
  ]],
  ["Pricing page chat", [
    "Is there a plan that includes LinkedIn and email sequences together?",
    "Do you charge per mailbox or per seat?",
    "Does the platform work with our existing HubSpot setup?",
  ]],
  ["Webinar: outbound in Q4", [
    "Attended the whole session. Would love the slides and a chat about the reply classifier.",
    "Asked a question about warm-up during the Q&A, following up here.",
  ]],
  ["G2 comparison page", [
    "Comparing you against two others. What makes your reply drafts different?",
    "Reading reviews, mostly curious about onboarding time.",
  ]],
  ["Referral", [
    "Dana at a customer of yours suggested we talk. We are about 40 reps and need better follow-up.",
    "Referred by a former colleague. Wants a short intro call.",
  ]],
  ["Content download", [
    "Downloaded the cold email benchmarks report.",
    "Grabbed the SDR onboarding template.",
  ]],
];

async function seedInboundWorkbook(ctx: DemoContext, folderId: string | null, used: Set<string>): Promise<void> {
  const createdAt = workTime(ctx, 27);
  const lastTouched = workTime(ctx, 1);
  const [workbook] = await db
    .insert(gridWorkbooks)
    .values({
      organizationId: ctx.organizationId,
      name: "Inbound leads · scoring",
      description: "Form fills and chat requests, scored so the team replies to the right ones first.",
      folderId,
      createdAt,
      updatedAt: lastTouched,
    })
    .returning({ id: gridWorkbooks.id });
  const people = ctx.rand.shuffle(ctx.people.filter((p) => !used.has(p.id))).slice(0, 42);
  people.forEach((p) => used.add(p.id));

  const columns: ColDef[] = [
    { key: "name", name: "Name", type: "text" },
    { key: "email", name: "Email", type: "email" },
    { key: "company", name: "Company", type: "text" },
    { key: "title", name: "Title", type: "text" },
    { key: "source", name: "Source", type: "select", config: { options: INBOUND_SOURCES.map(([s], i) => option(s, ["purple", "blue", "orange", "green", "pink", "gray"][i])) } },
    { key: "message", name: "What they asked", type: "text" },
    { key: "received", name: "Received", type: "date" },
    { key: "score", name: "Fit score", type: "number" },
    {
      key: "priority", name: "Priority", type: "formula", autoRun: true, dependsOn: ["score"],
      config: { expression: 'IF({{score}} >= 70, "Hot", IF({{score}} >= 45, "Warm", "Cold"))' } satisfies FormulaConfig,
    },
    { key: "assignedTo", name: "Assigned to", type: "select", config: { options: OWNER_OPTIONS } },
  ];
  const tableId = await createSheet({
    workbookId: workbook.id, name: "Inbound", position: 1, columns,
    view: { sorts: [{ columnKey: "score", direction: "desc" }] },
    createdAt, updatedAt: lastTouched,
  });
  const rows: SheetRow[] = people.map((p, i) => {
    const [source, messages] = ctx.rand.weighted(INBOUND_SOURCES.map((s) => [s, s[0] === "Demo request form" ? 4 : s[0] === "Content download" ? 3 : 2] as const));
    const score = Math.max(12, Math.min(98, ctx.rand.int(22, 96) + (source === "Demo request form" ? 8 : source === "Content download" ? -14 : 0)));
    const received = workTime(ctx, ctx.rand.int(1, 26));
    const cells = {
      name: p.fullName, email: p.email, company: p.company.name, title: p.title, source,
      message: ctx.rand.pick(messages), received: received.toISOString().slice(0, 10), score,
      priority: score >= 70 ? "Hot" : score >= 45 ? "Warm" : "Cold",
      assignedTo: ctx.rand.pick(OWNERS),
    };
    void i;
    return {
      cells,
      meta: { priority: doneMeta(addMs(received, 4 * MINUTE), undefined, 0) },
      createdAt: received,
      updatedAt: addMs(received, ctx.rand.int(5, 60) * MINUTE),
    };
  });
  await insertSheetRows(tableId, rows, []);
  count(ctx, "Tables: inbound leads", rows.length);
}

const BADGES = ["Attendee", "Speaker", "Sponsor"];
const EVENT_NOTES = [
  "Asked how we handle LinkedIn weekly invite limits. Told her we throttle per account; send the sending-rules page.",
  "Runs 8 SDRs on Outreach, hates the reply triage. Wants to see classification on his own inbox export.",
  "Met after the panel. Wants the Q4 cold email benchmarks deck before Friday.",
  "Renewal with a competitor in February. Said to circle back in early January, not before.",
  "Speaker. Offered an intro to their RevOps lead if we share the playbook from the talk.",
  "Lunch chat. Interested in WhatsApp outreach for the LATAM team, asked about number warm-up.",
  "Asked for pricing for 25 seats and whether mailboxes are included.",
  "Hiring two SDRs next month. Wants to talk before they pick tooling.",
  "Skeptical about AI drafts until we showed the review step. Asked to try it on 20 replies.",
  "Sponsor contact, not a buyer, but knows the VP of Sales at their parent company.",
  "Mutual customer introduced us. Lead with the case study, not the feature list.",
  "Wants a call with his CEO on it. Said to propose two slots next week.",
  "Collected a sticker and left. Probably a student, low priority.",
  "Already using a data vendor; only cares about the CRM sync. Send the HubSpot doc.",
  "Asked about GDPR and data residency. Needs a one-pager for legal.",
  "Said Q1 budget opens on the 15th; wants a quote ready by then.",
  "Brought two colleagues to the booth, all three asked about reporting.",
  "Struggling with deliverability on a new domain. Offered our warm-up checklist.",
  "Founder, 12-person team, doing outbound himself. Wants something cheap and quick to set up.",
  "Interested but her boss decides. Asked for a short deck she can forward.",
  "Left a card with a handwritten note: 'call Tuesday afternoon'.",
  "Compared us to a tool they trialled last year. Wants to know what changed on reply handling.",
  "Asked if we integrate with Salesforce campaigns. We do not. Honest answer given, still wants updates.",
  "Spoke for ten minutes about their event follow-up process; clear pain, no timeline yet.",
];
const FOLLOW_UP_OPTIONS = [option("To send", "gray"), option("Sent", "blue"), option("Replied", "orange"), option("Meeting booked", "green"), option("No fit", "red")];

async function seedEventWorkbook(ctx: DemoContext, folderId: string, used: Set<string>): Promise<void> {
  const createdAt = workTime(ctx, 22);
  const lastTouched = workTime(ctx, 5);
  const [workbook] = await db
    .insert(gridWorkbooks)
    .values({
      organizationId: ctx.organizationId,
      name: "RevOps Summit · attendees",
      description: "Badge scans and notes from the booth, with follow-up status per person.",
      folderId,
      createdAt,
      updatedAt: lastTouched,
    })
    .returning({ id: gridWorkbooks.id });
  const people = ctx.rand.shuffle(ctx.people.filter((p) => !used.has(p.id))).slice(0, 36);
  people.forEach((p) => used.add(p.id));
  const eventDay = workTime(ctx, 23);
  const eventNotes = ctx.rand.shuffle(EVENT_NOTES);
  const columns: ColDef[] = [
    { key: "name", name: "Name", type: "text" },
    { key: "title", name: "Title", type: "text" },
    { key: "company", name: "Company", type: "text" },
    { key: "email", name: "Email", type: "email" },
    { key: "badge", name: "Badge", type: "select", config: { options: BADGES.map((b, i) => option(b, ["gray", "purple", "orange"][i])) } },
    { key: "boothVisit", name: "Visited booth", type: "boolean" },
    { key: "scanned", name: "Scanned on", type: "date" },
    { key: "metBy", name: "Met by", type: "select", config: { options: OWNER_OPTIONS } },
    { key: "followUp", name: "Follow-up", type: "select", config: { options: FOLLOW_UP_OPTIONS } },
    { key: "notes", name: "Notes", type: "text" },
  ];
  const tableId = await createSheet({ workbookId: workbook.id, name: "Attendees", position: 1, columns, createdAt, updatedAt: lastTouched });
  const rows: SheetRow[] = people.map((p) => {
    const badge = ctx.rand.weighted([["Attendee", 24], ["Speaker", 3], ["Sponsor", 4]] as const);
    const booth = badge !== "Attendee" ? ctx.rand.chance(0.5) : ctx.rand.chance(0.75);
    const followUp = booth
      ? ctx.rand.weighted([["To send", 3], ["Sent", 5], ["Replied", 3], ["Meeting booked", 2], ["No fit", 2]] as const)
      : ctx.rand.weighted([["To send", 4], ["Sent", 2], ["No fit", 2]] as const);
    const scanned = new Date(eventDay.getTime() + ctx.rand.int(-4, 4) * HOUR);
    const cells = {
      name: p.fullName, title: p.title, company: p.company.name, email: p.email, badge, boothVisit: booth,
      scanned: scanned.toISOString().slice(0, 10), metBy: ctx.rand.pick(OWNERS), followUp,
      notes: booth && ctx.rand.chance(0.78) ? eventNotes.pop() ?? null : null,
    };
    return { cells, meta: {}, createdAt, updatedAt: ctx.rand.chance(0.7) ? workTime(ctx, ctx.rand.int(5, 20)) : createdAt };
  });
  rows.forEach((r) => { if (r.updatedAt < createdAt) r.updatedAt = createdAt; });
  await insertSheetRows(tableId, rows, []);
  count(ctx, "Tables: event attendees", rows.length);
}

async function seedTables(ctx: DemoContext): Promise<void> {
  const connections = await seedProviders(ctx);

  const [research] = await db
    .insert(gridFolders)
    .values({ organizationId: ctx.organizationId, name: "Account research", createdAt: workTime(ctx, 62), updatedAt: workTime(ctx, 2) })
    .returning({ id: gridFolders.id });
  const [events] = await db
    .insert(gridFolders)
    .values({ organizationId: ctx.organizationId, name: "Events", createdAt: workTime(ctx, 40), updatedAt: workTime(ctx, 5) })
    .returning({ id: gridFolders.id });
  count(ctx, "Tables: folders", 2);

  const { contactIds } = await seedAccountsWorkbook(ctx, research.id, connections);
  const used = new Set(contactIds);
  await seedInboundWorkbook(ctx, null, used);
  await seedEventWorkbook(ctx, events.id, used);
  count(ctx, "Tables: workbooks", 3);
}

// ---------------------------------------------------------------------------
// Prospecting: the storefront dataset
// ---------------------------------------------------------------------------

type CategorySpec = {
  c1: string;
  weight: number;
  pre: string[];
  suf: string[];
  subs: [c2: string, c3s: string[], weight: number][];
  /** Name endings that fit a given c3 (preferred) or c2, so a hair brand is not called "Skin". */
  sufBy?: Record<string, string[]>;
};

const CATEGORIES: CategorySpec[] = [
  {
    c1: "Beauty & Fitness", weight: 27,
    pre: ["Dewy", "Lumen", "Marlow", "Saltair", "Fernhill", "Oatbloom", "Verde", "Isla", "Honeywell", "Clover", "Nimbus", "Aster", "Pomelo", "Juniper", "Quill", "Sundry", "Lark", "Wildmoor", "Kindred", "Petal"],
    suf: ["Skin", "Botanicals", "Beauty", "Apothecary", "Skincare", "Cosmetics", "Hair Co.", "Fragrance", "Body", "Lab"],
    subs: [
      ["Face & Body Care", ["Skin & Nail Care", "Make-Up & Cosmetics", "Perfumes & Fragrances", "Hygiene & Toiletries", "Shaving & Hair Removal"], 8],
      ["Hair Care", [], 3],
      ["Fitness", [], 2],
    ],
    sufBy: {
      "Skin & Nail Care": ["Skin", "Skincare", "Botanicals", "Nail Co."], "Make-Up & Cosmetics": ["Cosmetics", "Beauty", "Color"],
      "Perfumes & Fragrances": ["Fragrance", "Parfum", "Scent Co."], "Hygiene & Toiletries": ["Body", "Apothecary", "Soap Co."],
      "Shaving & Hair Removal": ["Shave Co.", "Razor", "Grooming"], "Hair Care": ["Hair Co.", "Hair", "Haircare"], Fitness: ["Fitness", "Movement", "Athletics"],
    },
  },
  {
    c1: "Apparel", weight: 20,
    pre: ["Fieldstone", "Harlow", "Wren", "Alder", "Tern", "Ridgeway", "Calloway", "Ostler", "Beckett", "Marlin", "Thistle", "Ashby", "Rook", "Linden", "Garnet", "Slate"],
    suf: ["Apparel", "Supply", "Goods", "Outfitters", "Denim", "Knitwear", "Studio", "Threads"],
    subs: [["Women's Clothing", [], 5], ["Men's Clothing", [], 4], ["Athletic Apparel", [], 3], ["Footwear", [], 3], ["Children's Clothing", [], 2], ["Swimwear", [], 1]],
    sufBy: {
      "Women's Clothing": ["Apparel", "Studio", "Threads", "Clothing"], "Men's Clothing": ["Supply", "Goods", "Outfitters", "Denim"],
      "Athletic Apparel": ["Athletics", "Active", "Performance"], Footwear: ["Footwear", "Shoe Co.", "Boots"], "Children's Clothing": ["Kids", "Little Ones", "Junior"], Swimwear: ["Swim", "Swimwear"],
    },
  },
  {
    c1: "Home & Garden", weight: 18,
    pre: ["Hearth", "Oakline", "Birchwood", "Larder", "Maple", "Cedar", "Terrace", "Plume", "Fable", "Cobble", "Haven", "Nest", "Mosaic", "Tallow", "Warren"],
    suf: ["Home", "Living", "House", "Interiors", "Furnishings", "Kitchen", "Garden", "Studio", "Goods"],
    subs: [
      ["Home Furnishings", ["Lamps & Lighting", "Rugs & Carpets", "Living Room Furniture", "Curtains & Window Treatments"], 6],
      ["Kitchen & Dining", ["Cookware & Diningware", "Small Kitchen Appliances"], 4],
      ["Home & Interior Decor", [], 3],
      ["Bed & Bath", ["Bathroom"], 2],
      ["Gardening & Landscaping", [], 2],
    ],
    sufBy: {
      "Lamps & Lighting": ["Lighting", "Lamp Co."], "Rugs & Carpets": ["Rugs", "Weavers"], "Living Room Furniture": ["Furniture", "Living", "Home"],
      "Curtains & Window Treatments": ["Window Co.", "Drapery"], "Cookware & Diningware": ["Kitchen", "Cookware", "Table Co."], "Small Kitchen Appliances": ["Kitchen", "Appliance Co."],
      "Home & Interior Decor": ["Interiors", "Decor", "Home"], Bathroom: ["Bath", "Bath Co."], "Gardening & Landscaping": ["Garden", "Nursery", "Plant Co."],
    },
  },
  {
    c1: "Food & Drink", weight: 10,
    pre: ["Saltbox", "Ember", "Cinder", "Brindle", "Copper Kettle", "Sable", "Crumb", "Tamarind", "Fennel", "Bramble", "Gather", "Hollow"],
    suf: ["Coffee", "Tea Co.", "Pantry", "Provisions", "Kitchen", "Roasters", "Chocolate", "Snacks"],
    subs: [["Beverages", ["Coffee & Tea", "Alcoholic Beverages", "Juice"], 5], ["Food", ["Snack Foods", "Candy & Sweets", "Baked Goods & Desserts", "BBQ & Grilling"], 5]],
    sufBy: {
      "Coffee & Tea": ["Coffee", "Roasters", "Tea Co."], "Alcoholic Beverages": ["Spirits", "Distilling", "Wine Co."], Juice: ["Juice", "Press"],
      "Snack Foods": ["Snacks", "Pantry"], "Candy & Sweets": ["Sweets", "Confections"], "Baked Goods & Desserts": ["Bakery", "Baking Co."], "BBQ & Grilling": ["BBQ", "Smokehouse"],
      Beverages: ["Drinks", "Beverage Co."], Food: ["Provisions", "Kitchen", "Pantry"],
    },
  },
  {
    c1: "Health", weight: 9,
    pre: ["Vital", "Evergreen", "Thrive", "Meadow", "Ritual Roots", "Pulse", "Nourish", "Solace", "Bright", "Tonic", "Haven & Hale"],
    suf: ["Wellness", "Nutrition", "Health", "Supplements", "Naturals", "Labs"],
    subs: [["Nutrition", ["Vitamins & Supplements", "Special & Restricted Diets"], 6], ["Oral & Dental Care", [], 2], ["Vision Care", ["Eyeglasses & Contacts"], 1], ["Women's Health", [], 2]],
    sufBy: {
      "Vitamins & Supplements": ["Supplements", "Nutrition", "Naturals"], "Special & Restricted Diets": ["Nutrition", "Foods"], Nutrition: ["Nutrition", "Wellness"],
      "Oral & Dental Care": ["Oral Care", "Smile Co."], "Eyeglasses & Contacts": ["Optics", "Eyewear"], "Women's Health": ["Health", "Wellness"],
    },
  },
  {
    c1: "Sports", weight: 8,
    pre: ["Summit", "Torrent", "Ridgeline", "Kestrel", "Basecamp", "Tidewater", "Granite", "Northbound", "Switchback", "Drift"],
    suf: ["Outdoors", "Sports", "Gear", "Cycling", "Outfitters", "Supply Co."],
    subs: [["Sporting Goods", ["Hiking & Camping", "Fishing", "Outdoors"], 5], ["Individual Sports", ["Cycling", "Golf", "Racquet Sports"], 3], ["Water Sports", ["Surfing"], 1]],
    sufBy: {
      "Hiking & Camping": ["Outdoors", "Trail Co.", "Outfitters"], Fishing: ["Fishing", "Tackle"], Outdoors: ["Outdoors", "Gear"], Cycling: ["Cycling", "Bike Co."],
      Golf: ["Golf"], "Racquet Sports": ["Racquet Co.", "Sports"], Surfing: ["Surf Co.", "Surf"],
    },
  },
  {
    c1: "Pets & Animals", weight: 5,
    pre: ["Biscuit", "Whisker", "Pawsome", "Tailwind", "Otto", "Mochi", "Juno", "Pickle"],
    suf: ["Pet Co.", "Pets", "Supply", "Treats", "Goods"],
    subs: [["Pet Food & Supplies", [], 6], ["Dogs", [], 3], ["Cats", [], 2]],
    sufBy: { "Pet Food & Supplies": ["Pet Co.", "Pets", "Supply", "Treats"], Dogs: ["Dog Co.", "Dogs", "Treats"], Cats: ["Cat Co.", "Cats"] },
  },
  {
    c1: "Consumer Electronics", weight: 3,
    pre: ["Arcline", "Voltaic", "Nordic Wave", "Halcyon", "Pixel & Pine", "Kilo"],
    suf: ["Audio", "Mobile", "Tech", "Electronics"],
    subs: [["Audio Equipment", [], 3], ["Mobile & Wireless", ["Mobile & Wireless Accessories"], 2]],
    sufBy: { "Audio Equipment": ["Audio", "Sound"], "Mobile & Wireless Accessories": ["Mobile", "Accessories"], "Mobile & Wireless": ["Mobile", "Wireless"] },
  },
];

const COUNTRY_MIX: [string, number][] = [["US", 262], ["GB", 30], ["DE", 16], ["CA", 22], ["AU", 18], ["IN", 12]];
const PLATFORM_MIX: [string, number][] = [["Shopify", 74], ["WooCommerce", 10], ["BigCommerce", 7], ["Magento", 5], ["Wix", 2], ["Squarespace", 2]];

type Store = {
  domain: string;
  name: string;
  platform: string;
  country: string;
  c1: string;
  c2: string;
  c3: string | null;
  revenue: number;
  apps: string[];
};

function validateTaxonomy() {
  const l2 = categoriesData.l2 as Record<string, string[]>;
  const l3 = categoriesData.l3 as Record<string, string[]>;
  for (const cat of CATEGORIES) {
    for (const [c2, c3s] of cat.subs) {
      if (!l2[cat.c1]?.includes(c2)) throw new Error(`Unknown category ${cat.c1} > ${c2}`);
      for (const c3 of c3s) if (!l3[`${cat.c1} > ${c2}`]?.includes(c3)) throw new Error(`Unknown category ${cat.c1} > ${c2} > ${c3}`);
    }
  }
}

const NON_DTC_APPS = /dropship|dsers|cjdrop|print on demand|printful|printify|gelato|affiliate|aliexpress/i;

function buildStores(ctx: DemoContext): Store[] {
  validateTaxonomy();
  const takenDomains = new Set(ctx.companies.map((c) => c.domain));
  const takenNames = new Set<string>();
  const apps = (appsData as { name: string; count: number }[]).slice(0, 110).filter((a) => !NON_DTC_APPS.test(a.name));
  const stores: Store[] = [];
  const countries = COUNTRY_MIX.flatMap(([cc, n]) => Array.from({ length: n }, () => cc));

  for (const country of ctx.rand.shuffle(countries)) {
    const cat = ctx.rand.weighted(CATEGORIES.map((c) => [c, c.weight] as const));
    const [c2, c3s] = ctx.rand.weighted(cat.subs.map((s) => [[s[0], s[1]] as const, s[2]] as const));
    const c3 = c3s.length && ctx.rand.chance(0.7) ? ctx.rand.pick(c3s) : null;
    let name = "";
    let domain = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      const pre = ctx.rand.pick(cat.pre);
      const suf = ctx.rand.pick((c3 && cat.sufBy?.[c3]) || cat.sufBy?.[c2] || cat.suf);
      name = ctx.rand.chance(0.18) ? pre : `${pre} ${suf}`;
      const slug = slugify(name);
      const style = ctx.rand.weighted([["plain", 6], ["get", 1], ["shop", 1.5], ["wear", 0.4], ["try", 1]] as const);
      domain = `${style === "plain" ? "" : style === "wear" ? "wear" : style}${slug}.example`;
      if (!takenNames.has(name) && !takenDomains.has(domain)) break;
      name = "";
    }
    if (!name) continue;
    takenNames.add(name);
    takenDomains.add(domain);

    const platform = ctx.rand.weighted(PLATFORM_MIX.map(([p, w]) => [p, w] as const));
    // Revenue: lognormal around $2.5M, slightly smaller outside the US.
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, ctx.rand.next()))) * Math.cos(2 * Math.PI * ctx.rand.next());
    const scale = country === "US" ? 1 : country === "IN" ? 0.35 : 0.7;
    const revenue = Math.max(90_000, Math.min(160_000_000, round(Math.exp(Math.log(2_500_000 * scale) + 1.05 * z), platform === "Shopify" ? 100 : 1000)));
    const pApp = platform === "Shopify" ? 1 : 0.4;
    const installed = apps
      .filter((a) => ctx.rand.chance(Math.min(0.85, (a.count / 650_000) * 1.15) * pApp))
      .map((a) => a.name);
    stores.push({ domain, name, platform, country, c1: cat.c1, c2, c3, revenue, apps: installed });
  }
  return stores;
}

async function seedStores(ctx: DemoContext, stores: Store[]): Promise<void> {
  const byRevenue = [...stores].sort((a, b) => b.revenue - a.revenue);
  const rankOf = new Map(byRevenue.map((s, i) => [s.domain, Math.round(400 * (i + 1) ** 1.5) + i * 7 + ctx.rand.int(0, 30)]));
  const rows = stores.map((s) => ({
    domain: s.domain,
    merchantName: s.name,
    platform: s.platform,
    rank: rankOf.get(s.domain)!,
    countryCode: s.country,
    annualSales: String(s.revenue),
    categories: `/${s.c1}/${s.c2}${s.c3 ? `/${s.c3}` : ""}`,
    c1: s.c1,
    c2: s.c2,
    c3: s.c3,
    installedApps: s.apps.map((a) => a.replace(/\W+/g, "-").toLowerCase()).join(":") || null,
    installedAppsNames: s.apps.join(":") || null,
    installedAppsArray: s.apps.length ? s.apps : null,
    emails: `hello@${s.domain}`,
    phones: null,
  }));
  for (let i = 0; i < rows.length; i += 100) await db.insert(cleanDomains).values(rows.slice(i, i + 100)).onConflictDoNothing();
  count(ctx, "Prospecting: storefront domains", rows.length);
}

// ---------------------------------------------------------------------------
// Prospecting: qualification campaigns
// ---------------------------------------------------------------------------

type CampaignPlan = {
  name: string;
  inputMode: "filters" | "manual";
  filters: Record<string, string> | null;
  jobTitles: string[];
  targetMode: "leads" | "domains";
  targetLeadCount: number;
  targetDomainCount: number | null;
  createdDaysAgo: number;
  candidates: Store[];
  limit: number;
};

const NOT_LIVE_REASONS = ["Shopify store unavailable", "unreachable: ENOTFOUND", "unreachable: connect ETIMEDOUT", "reachable but returned HTTP 403", "unreachable: certificate has expired"];
const PARENT_NAMES = ["Oakline Brands", "Fernhill Holdings", "Tidewater Group", "Kindred and Co Brands", "Northbound Collective", "Larkspur Consumer", "Halden Brands", "Meridian Commerce Group", "Wexford Direct", "Pennant Holdings", "Ashgrove Brands", "Corvid Consumer", "Bellwether Brands", "Stonecrop Group"];
let parentNames: string[] = [];

function apolloTrace(domain: string, label: "all_people" | "verified_people", total: number, startedAt: Date): ApolloSearchDebugTrace {
  return {
    label,
    method: "POST" as const,
    url: "https://api.apollo.io/api/v1/mixed_people/api_search",
    query: label === "all_people" ? { "q_organization_domains_list[]": [domain], per_page: "1" } : { "q_organization_domains_list[]": [domain], "contact_email_status[]": ["verified"], per_page: "1" },
    status: 200,
    response: { total_entries: total, pagination: { page: 1, per_page: 1, total_entries: total } },
    totalEntries: total,
    startedAt: startedAt.toISOString(),
    finishedAt: addMs(startedAt, 700).toISOString(),
  };
}

function apolloDebug(domain: string, all: number, verified: number, at: Date): ApolloLeadDebugTrace {
  return { domain, domains: [domain], allPeople: apolloTrace(domain, "all_people", all, at), verifiedPeople: apolloTrace(domain, "verified_people", verified, addMs(at, 900)) };
}

function parentLookupTrace(domain: string, parent: string | null, at: Date): NonNullable<QualificationDebugTrace["parentLookup"]> {
  return {
    request: {
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1",
      model: AI_MODEL,
      instructions: "Identify the parent company domain for this e-commerce store. Use web search to research ownership, parent company, brand operator, and official company references before deciding. If it is independently owned or uncertain, return null. Submit the answer by calling the report_parent_domain function.",
      input: domain,
      maxOutputTokens: 2000,
      tool: "report_parent_domain",
      tools: [{ type: "web_search" }],
    },
    response: {
      status: "completed",
      outputText: JSON.stringify({ parentDomain: parent }),
      parsedParentDomain: parent,
      webSearchUsed: true,
    },
    startedAt: at.toISOString(),
    finishedAt: addMs(at, 9_000 + Math.round(Math.abs(Math.sin(domain.length)) * 6000)).toISOString(),
  };
}

type PlannedRow = {
  id: string;
  domain: string;
  status: string;
  isParentCompany: boolean;
  isLive: boolean | null;
  allLeadCount: number | null;
  verifiedEmployeeCount: number | null;
  revenue: string | null;
  parentId: string | null;
  parentDomain: string | null;
  parentPending: boolean;
  reason: string | null;
  qualificationDebug: QualificationDebugTrace | null;
  checkedAt: Date;
};

function statusFor(ctx: DemoContext, revenue: number): { status: string; all: number; verified: number } {
  const lift = Math.min(0.2, Math.log10(Math.max(1, revenue / 1_000_000)) * 0.18);
  const roll = ctx.rand.next();
  if (roll < 0.1) return { status: "not_live", all: 0, verified: 0 };
  if (roll < 0.1 + 0.34 + lift) {
    const verified = ctx.rand.int(10, 64);
    return { status: "qualified", all: verified + ctx.rand.int(6, 90), verified };
  }
  if (roll < 0.1 + 0.34 + lift + 0.24) {
    const verified = ctx.rand.int(0, 9);
    return { status: "apollo_has_data", all: verified + ctx.rand.int(1, 28), verified };
  }
  return { status: "apollo_no_data", all: 0, verified: 0 };
}

async function seedCampaign(
  ctx: DemoContext,
  plan: CampaignPlan,
  opts: { startParentsFrom?: PlannedRow },
): Promise<{ rows: PlannedRow[]; campaignId: string }> {
  const created = workTime(ctx, plan.createdDaysAgo);
  const startedAt = addMs(created, ctx.rand.int(2, 14) * MINUTE);
  let clock = addMs(startedAt, 4_000);

  const rows: PlannedRow[] = [];
  const parentRows: PlannedRow[] = [];
  let accumulated = 0;
  let processed = 0;
  let qualifiedCount = 0;
  const candidates = plan.candidates.slice(0, plan.limit);
  const parentAt = new Set<number>();
  // A few children turn out to belong to a larger operator.
  const parentSlots = ctx.rand.shuffle(candidates.map((_, i) => i)).slice(0, Math.max(2, Math.round(candidates.length / 9)));
  parentSlots.forEach((i) => parentAt.add(i));
  let sharedParent: PlannedRow | null = null;
  let reused = false;

  for (let i = 0; i < candidates.length; i++) {
    const store = candidates[i];
    clock = addMs(clock, ctx.rand.int(5, 24) * 1000);
    const { status, all, verified } = statusFor(ctx, store.revenue);
    const row: PlannedRow = {
      id: randomUUID(),
      domain: store.domain,
      status,
      isParentCompany: false,
      isLive: status !== "not_live",
      allLeadCount: status === "not_live" ? null : all,
      verifiedEmployeeCount: status === "not_live" ? null : verified,
      revenue: String(store.revenue),
      parentId: null,
      parentDomain: null,
      parentPending: false,
      reason: null,
      qualificationDebug: null,
      checkedAt: clock,
    };
    processed += 1;
    if (status === "not_live") {
      row.reason = ctx.rand.pick(NOT_LIVE_REASONS);
    } else {
      let parentReason = "";
      const hasParent = parentAt.has(i) && status !== "not_live";
      let debug: QualificationDebugTrace = { apollo: { child: apolloDebug(store.domain, all, verified, addMs(clock, -2_000)) } };
      if (hasParent) {
        // The first parent found in an earlier campaign is reused ("previously added").
        const reuse = opts.startParentsFrom && !reused ? opts.startParentsFrom : null;
        if (reuse) reused = true;
        if (reuse) {
          row.parentId = reuse.id;
          row.parentDomain = reuse.domain;
          parentReason = `; parent: ${reuse.domain} (previously added)`;
          debug = { parentLookup: parentLookupTrace(store.domain, reuse.domain, addMs(clock, -14_000)), ...debug };
        } else {
          const parentDomain: string = sharedParent && ctx.rand.chance(0.4) ? sharedParent.domain : `${slugify(parentNames.pop() ?? `holdings${i}`)}.example`;
          const existing: PlannedRow | undefined = parentRows.find((p) => p.domain === parentDomain);
          let parent: PlannedRow | undefined = existing;
          if (!parent) {
            const pv = ctx.rand.chance(0.7) ? ctx.rand.int(10, 70) : ctx.rand.int(0, 8);
            const pa = pv + ctx.rand.int(2, 60);
            const pStatus = pv >= 10 ? "qualified" : "apollo_has_data";
            parent = {
              id: randomUUID(), domain: parentDomain, status: pStatus, isParentCompany: true, isLive: true,
              allLeadCount: pa, verifiedEmployeeCount: pv, revenue: String(store.revenue), parentId: null, parentDomain: null, parentPending: false,
              reason: `parent lookup from ${store.domain}: ${pv >= 10 ? `${pv} verified-email leads on Apollo` : `${pa} total leads but only ${pv} verified for ${parentDomain}`}`,
              qualificationDebug: { apollo: { child: apolloDebug(parentDomain, pa, pv, addMs(clock, -1_000)) } },
              checkedAt: addMs(clock, 3_000),
            };
            parentRows.push(parent);
            sharedParent = parent;
            if (pStatus === "qualified") accumulated += pv;
          }
          row.parentId = parent.id;
          row.parentDomain = parent.domain;
          parentReason = `; parent: ${parent.domain}`;
          debug = { parentLookup: parentLookupTrace(store.domain, parent.domain, addMs(clock, -14_000)), apollo: { ...debug.apollo, parent: parent.qualificationDebug?.apollo?.child } };
        }
      } else if (status === "apollo_no_data" || status === "apollo_has_data") {
        // Either the model found nobody, or it could not decide.
        if (ctx.rand.chance(0.45)) {
          row.parentPending = true;
        } else {
          parentReason = "; parent same as domain";
        }
        debug = { parentLookup: parentLookupTrace(store.domain, ctx.rand.chance(0.5) ? store.domain : null, addMs(clock, -14_000)), ...debug };
      } else {
        parentReason = "; parent same as domain";
        debug = { parentLookup: parentLookupTrace(store.domain, store.domain, addMs(clock, -14_000)), ...debug };
      }
      row.reason =
        status === "qualified"
          ? `${verified} verified-email leads on Apollo${parentReason}`
          : status === "apollo_has_data"
            ? `${all} total leads but only ${verified} verified${parentReason || "; parent unknown"}`
            : `no Apollo data for ${store.domain}${parentReason}`;
      row.qualificationDebug = debug;
    }
    if (status === "qualified") {
      qualifiedCount += 1;
      accumulated += verified;
    }
    rows.push(row);
    if (plan.targetMode === "leads" && accumulated >= plan.targetLeadCount) break;
  }

  let target = plan.targetLeadCount;
  if (plan.targetMode === "leads" && accumulated < target) target = Math.max(50, Math.floor(accumulated / 50) * 50);
  const finishedAt = addMs(rows.length ? rows[rows.length - 1].checkedAt : clock, ctx.rand.int(6, 20) * 1000);

  const qualifiedDomains = [...rows, ...parentRows].filter((r) => r.status === "qualified").map((r) => r.domain);
  const [campaign] = await db
    .insert(campaigns)
    .values({
      organizationId: ctx.organizationId,
      name: plan.name,
      inputMode: plan.inputMode,
      filters: plan.filters,
      jobTitles: plan.jobTitles,
      targetMode: plan.targetMode,
      targetLeadCount: target,
      targetDomainCount: plan.targetMode === "domains" ? (plan.targetDomainCount ?? rows.length) : null,
      accumulatedLeadCount: accumulated,
      apolloLink: qualifiedDomains.length ? buildApolloPeopleSearchUrl({ domains: qualifiedDomains, titles: plan.jobTitles }) : null,
      status: "ready",
      createdAt: created,
    })
    .returning({ id: campaigns.id });

  const all = [...rows, ...parentRows];
  await db.insert(targetedDomains).values(
    all.map((r) => ({
      organizationId: ctx.organizationId,
      id: r.id,
      domain: r.domain,
      campaignId: campaign.id,
      status: r.status,
      isParentCompany: r.isParentCompany,
      isLive: r.isLive,
      allLeadCount: r.allLeadCount,
      verifiedEmployeeCount: r.verifiedEmployeeCount,
      revenue: r.revenue,
      parentId: r.parentId,
      parentDomain: r.parentDomain,
      parentPending: r.parentPending,
      reason: r.reason,
      qualificationDebug: r.qualificationDebug,
      checkedAt: r.checkedAt,
    })),
  );
  await db.insert(qualificationJobs).values({
    campaignId: campaign.id,
    status: "success",
    requestedLimit: plan.targetMode === "leads" ? plan.limit : null,
    currentDomain: null,
    domainsProcessed: processed,
    domainsQualified: qualifiedCount,
    lastHeartbeatAt: finishedAt,
    startedAt,
    finishedAt,
  });
  count(ctx, "Prospecting: qualification campaigns", 1);
  count(ctx, "Prospecting: qualified-domain rows", all.length);
  return { rows: all, campaignId: campaign.id };
}

async function seedProspecting(ctx: DemoContext): Promise<void> {
  parentNames = ctx.rand.shuffle(PARENT_NAMES);
  const stores = buildStores(ctx);
  await seedStores(ctx, stores);

  const byRevenue = (list: Store[]) => [...list].sort((a, b) => b.revenue - a.revenue);
  const beauty = byRevenue(stores.filter((s) => s.country === "US" && s.platform === "Shopify" && s.c1 === "Beauty & Fitness" && s.revenue >= 1_000_000));
  const home = byRevenue(stores.filter((s) => s.country === "US" && s.platform === "Shopify" && s.c1 === "Home & Garden" && s.revenue >= 500_000));
  const manualPool = stores.filter((s) => s.country === "US" && !beauty.includes(s) && !home.includes(s) && (s.c1 === "Apparel" || s.c1 === "Sports" || s.c1 === "Food & Drink"));
  const manual = ctx.rand.shuffle(manualPool).slice(0, 14);

  const first = await seedCampaign(
    ctx,
    {
      name: "US Shopify beauty brands, $1M+",
      inputMode: "filters",
      filters: { countryCode: "US", platform: "Shopify", c1: "Beauty & Fitness", minRevenue: "1000000" },
      jobTitles: ["Head of Growth", "VP Marketing", "Director of E-commerce", "Founder"],
      targetMode: "domains",
      targetLeadCount: 3000,
      targetDomainCount: Math.min(beauty.length, 48),
      createdDaysAgo: 24,
      candidates: beauty,
      limit: Math.min(beauty.length, 48),
    },
    {},
  );
  const reusable = first.rows.find((r) => r.isParentCompany && r.status === "qualified") ?? first.rows.find((r) => r.isParentCompany);

  await seedCampaign(
    ctx,
    {
      name: "Home & garden · Shopify · $500K+ (Q4 test)",
      inputMode: "filters",
      filters: { countryCode: "US", platform: "Shopify", c1: "Home & Garden", minRevenue: "500000" },
      jobTitles: ["Head of E-commerce", "Marketing Director", "Founder"],
      targetMode: "leads",
      targetLeadCount: 250,
      targetDomainCount: null,
      createdDaysAgo: 13,
      candidates: home,
      limit: 60,
    },
    { startParentsFrom: reusable },
  );

  await seedCampaign(
    ctx,
    {
      name: "Brands from the RevOps Summit list",
      inputMode: "manual",
      filters: null,
      jobTitles: ["VP Marketing", "Head of Growth"],
      targetMode: "domains",
      targetLeadCount: 3000,
      targetDomainCount: manual.length,
      createdDaysAgo: 6,
      candidates: manual,
      limit: manual.length,
    },
    {},
  );
}

// ---------------------------------------------------------------------------

export async function seedWorkspace(ctx: DemoContext): Promise<void> {
  currentOrg = ctx.organizationId;
  await seedTables(ctx);
  await seedProspecting(ctx);
}
