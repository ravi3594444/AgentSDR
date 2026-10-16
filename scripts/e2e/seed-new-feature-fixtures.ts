/**
 * Puts one row of each table added by scripts/add-instagram-intake-discovery.ts
 * (and the new lead-list columns) into an organization, so
 * scripts/e2e/tenancy-isolation.ts has organization A identifiers in every
 * new table to look for in organization B's responses.
 *
 *   ORGANIZATION_ID=<org> bun run --conditions=react-server scripts/e2e/seed-new-feature-fixtures.ts
 *
 * Local disposable databases only (refuses anything else). Inserts only; it
 * turns the organization's optional features on, so the new routes answer
 * for it the way they would for an organization that chose them.
 */
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const organizationId = process.env.ORGANIZATION_ID;
if (!organizationId) {
  console.error("Set ORGANIZATION_ID to the organization to seed.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { people } = await import("@/lib/leads/schema");
const { instagramAccounts, instagramChats, instagramMessages } = await import("@/lib/instagram/schema");
const { intakeEndpoints, inquiries } = await import("@/lib/intake/schema");
const { leadAudienceMemberInsights, leadAudienceMembers, outreachRuns } = await import("@/lib/assistant/schema");
const { createAudience } = await import("@/lib/assistant/audiences.server");
const { setFeature } = await import("@/lib/features/flags.server");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { apifyRuns, apifySettings } = await import("@/lib/apify/schema");
const { encryptIntegrationCredential } = await import("@/lib/integrations/credentials");

const stamp = Date.now();
await runInOrganization(organizationId, async () => {
  for (const key of ["instagram", "web_discovery", "inquiry_intake", "apify_discovery"] as const) await setFeature(key, true, null);
  await db.insert(apifySettings).values({ organizationId, encryptedToken: encryptIntegrationCredential(`iso-apify-token-${stamp}`), tokenHint: "…iso1", approvedActors: ["google_maps"] }).onConflictDoNothing();
  await db.insert(apifyRuns).values({ organizationId, actorKey: "google_maps", actorId: "compass~crawler-google-places", apifyRunId: `iso-apify-run-${stamp}`, datasetId: `iso-apify-dataset-${stamp}`, requestId: `iso-request-${stamp}`, status: "succeeded", maxChargeUsd: 2, maxItems: 20, usageUsd: 0.42, itemsRead: 5, finishedAt: new Date() });
  const [person] = await db.insert(people).values({ organizationId, fullName: "Isolation Inquirer", email: `isolation-inquirer-${stamp}@example.test`, source: "intake:website-form" }).returning();
  const [account] = await db.insert(instagramAccounts).values({ organizationId, unipileAccountId: `iso-ig-${stamp}`, username: `iso_account_${stamp}`, name: "Isolation IG", status: "connected", connectedAt: new Date(), historyCutoffAt: new Date(), inquiryIntake: true }).returning();
  const [chat] = await db.insert(instagramChats).values({ accountId: account!.id, unipileChatId: `iso-chat-${stamp}`, providerId: `iso-provider-${stamp}`, username: `iso_lead_${stamp}`, name: "Isolation Lead", personId: person!.id }).returning();
  await db.insert(instagramMessages).values({ chatId: chat!.id, unipileMessageId: `iso-msg-${stamp}`, direction: "inbound", origin: "lead", body: `isolation secret message ${stamp}`, sentAt: new Date() });
  const [endpoint] = await db.insert(intakeEndpoints).values({ organizationId, name: `Isolation form ${stamp}`, tokenHash: `iso-hash-${stamp}`, tokenHint: "abcd", fieldMap: { email: "email" } }).returning();
  await db.insert(inquiries).values({ organizationId, source: "website_form", endpointId: endpoint!.id, dedupeKey: `iso-${stamp}`, personId: person!.id, name: "Isolation Inquirer", email: `isolation-inquirer-${stamp}@example.test`, message: `isolation inquiry ${stamp}` });
  const audienceId = await createAudience({ name: `Isolation list ${stamp}`, source: "list", criteria: { source: "inquiries" } });
  const [member] = await db.insert(leadAudienceMembers).values({ organizationId, audienceId, personId: person!.id, name: "Isolation Inquirer", status: "eligible", channels: ["email"], source: "inquiry:website_form" }).returning();
  await db.insert(leadAudienceMemberInsights).values({ memberId: member!.id, matchReason: `isolation reason ${stamp}`, signals: [{ kind: "need", text: `isolation need ${stamp}`, sourceUrl: null, source: "website form", at: null }] });
  await db.insert(outreachRuns).values({
    organizationId,
    audienceId,
    name: `Isolation inquiry run ${stamp}`,
    status: "proposed",
    channels: [],
    plan: { kind: "inquiries", inquiry: { channels: ["instagram"], accounts: [] }, assignments: [], sequences: {}, personalizationKey: "", samples: [], limits: { maxLeads: 0, emailPerMailboxPerDay: null, whatsappNewChatsPerDay: null }, excluded: [], estimate: { aiCalls: 0, aiCostUsd: null, days: null }, autopilot: false, instructions: null },
  });
  console.log(`Seeded new-feature fixtures into ${organizationId}: instagram account ${account!.id}, chat ${chat!.id}, endpoint ${endpoint!.id}, audience ${audienceId}.`);
});
process.exit(0);

export {};
