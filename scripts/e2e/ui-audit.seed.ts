export {};
/** This fixture is only for the disposable local browser checks. */
if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):55479\/agentsdr_review$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable agentsdr_review database on port 55479");
const { hashPassword } = await import("better-auth/crypto");
const { db } = await import("@/lib/db");
const { users, accounts, organizations, members } = await import("@/lib/auth/schema");
const { assistantThreads, assistantMessages, assistantJobs } = await import("@/lib/assistant/schema");
const { writeFileSync } = await import("node:fs");
const email = `ui-audit-${Date.now()}@example.test`;
const password = "Local-browser-test-only-123!";
const [user] = await db.insert(users).values({ name: "UI audit owner", email, emailVerified: true }).returning();
const [org] = await db.insert(organizations).values({ name: "UI audit workspace", slug: `ui-audit-${Date.now()}` }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
await db.insert(accounts).values({ userId: user!.id, accountId: user!.id, providerId: "credential", password: await hashPassword(password) });
const [thread] = await db.insert(assistantThreads).values({ organizationId: org!.id, title: "Requests browser check", createdBy: user!.id }).returning();
const [message] = await db.insert(assistantMessages).values({ organizationId: org!.id, threadId: thread!.id, role: "user", content: "Research dentists without sending" }).returning();
await db.insert(assistantJobs).values({ organizationId: org!.id, threadId: thread!.id, kind: "discovery", status: "succeeded", stage: "done", payload: { requestMessageId: message!.id, phrase: "Dentists" }, result: { found: 3, eligible: 2 } });
const classificationRecords: string[] = [];
const briefText = "Noted the request — Goal: Find successful business owners and ask about their largest business costs.";
let emailRecordId: string | null = null;
if (["setup", "isolation"].includes(process.env.UI_AUDIT_PHASE ?? "")) {
  const { gridProviders, gridProviderCredentials } = await import("@/lib/grid/schema");
  const { mailboxes } = await import("@/lib/outreach/schema");
  const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
  const { instagramAccounts } = await import("@/lib/instagram/schema");
  const { organizationFeatures } = await import("@/lib/features/schema");
  const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
  const organizationId = org!.id;
  const stamp = Date.now();
  const providerValues = { baseUrl: "https://unipile-fixture.invalid", apiKey: "local-ui-test-only", notifySecret: "local-ui-test-only" };
  if (process.env.UI_AUDIT_PROVIDER_MODE === "included") {
    const { platformCredentials } = await import("@/lib/managed/schema");
    await db.insert(platformCredentials).values({ provider: "unipile", encryptedPayload: encryptIntegrationCredentials(providerValues), fingerprint: "local-ui-test-only", config: { verifiedAt: new Date().toISOString() } });
  } else {
    const [platform] = await db.insert(gridProviders).values({ organizationId, key: "platform-unipile", name: "Local UI provider", config: { platformKey: "unipile", values: { baseUrl: providerValues.baseUrl }, secretsSet: ["apiKey"], verifiedAt: new Date().toISOString(), webhooks: { status: "registered", items: [{ key: "unipile-email" }] } } }).returning();
    await db.insert(gridProviderCredentials).values({ providerId: platform!.id, encryptedPayload: encryptIntegrationCredentials(providerValues) });
  }
  await db.insert(mailboxes).values([0, 1, 2].map(n => ({ organizationId, provider: "unipile" as const, emailAddress: `sender-${n}-${stamp}@example.test`, unipileAccountId: `ui-email-${stamp}-${n}`, status: n < 2 ? "connected" as const : "failed" as const })));
  await db.insert(whatsappAccounts).values([0, 1].map(n => ({ organizationId, unipileAccountId: `ui-wa-${stamp}-${n}`, name: `Test number ${n}`, status: n === 0 ? "connected" as const : "disconnected" as const, connectedAt: new Date(Date.now() - 86_400_000) })));
  await db.insert(organizationFeatures).values({ organizationId, key: "instagram", enabled: true });
  await db.insert(instagramAccounts).values([0, 1].map(n => ({ organizationId, unipileAccountId: `ui-ig-${stamp}-${n}`, username: `test_${n}`, status: n === 0 ? "connected" as const : "disconnected" as const })));
  if (process.env.UI_AUDIT_PHASE === "setup") {
    const [ai] = await db.insert(gridProviders).values({ organizationId, key: `ai-ui-${stamp}`, name: "Local UI AI fixture", config: { aiProviderKey: "aimlapi", verification: { status: "verified", verifiedAt: new Date().toISOString() } } }).returning();
    await db.insert(gridProviders).values({ organizationId, key: "openrouter-byok-settings", name: "Local UI AI selection", config: { connectionId: ai!.id, providers: ["aimlapi"], modelsByProvider: { aimlapi: ["fixture-model"] }, defaultModel: { provider: "aimlapi", modelId: "fixture-model" } } });
  } else console.log("Offline isolation fixture: no AI provider selected or AI credentials stored");
}
if (["classification", "isolation"].includes(process.env.UI_AUDIT_PHASE ?? "")) {
  console.log("Seeding held classification fixtures");
  const { runInOrganization } = await import("@/lib/tenancy/scope");
  const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
  const { people } = await import("@/lib/leads/schema");
  const { crmRecords, crmConversations, crmConversationMessages, crmClassifications } = await import("@/lib/crm/schema");
  const { and, eq } = await import("drizzle-orm");
  await runInOrganization(org!.id, async () => {
    const organizationId = org!.id;
    const { pipelineId } = await ensureCrmDefaults();
    console.log("CRM fixture defaults ready");
    for (const [index, categoryKey] of ["other", "interested"].entries()) {
      const name = index === 0 ? "Same classification prospect" : "Changed classification prospect";
      const [person] = await db.insert(people).values({ organizationId, source: "list", fullName: name, email: `classification-${index}-${Date.now()}@example.test` }).returning();
      const [record] = await db.insert(crmRecords).values({ organizationId, personId: person!.id, pipelineId, categoryKey, categorySource: "human", workflowState: "action_required", activeChannel: "email", lastInboundAt: new Date(), lastInteractionAt: new Date() }).returning();
      const accountRef = `classification-${org!.id}@example.test`;
      const [conversation] = await db.insert(crmConversations).values({ organizationId, crmRecordId: record!.id, personId: person!.id, channel: "email", accountRef, providerThreadId: `ui-${record!.id}` }).returning();
      const [inbound] = await db.insert(crmConversationMessages).values({ conversationId: conversation!.id, personId: person!.id, channel: "email", accountRef, direction: "inbound", idempotencyKey: `ui-${record!.id}`, bodyText: "Please send more information.", sentAt: new Date() }).returning();
      await db.update(crmRecords).set({ latestInboundMessageId: inbound!.id }).where(and(eq(crmRecords.organizationId, organizationId), eq(crmRecords.id, record!.id)));
      await db.insert(crmClassifications).values({ crmRecordId: record!.id, messageId: inbound!.id, expectedContextVersion: record!.contextVersion, previousCategoryKey: categoryKey, proposedCategoryKey: "other", confidence: "0.9000", reasoning: "Local held-proposal fixture", status: "proposed" });
      classificationRecords.push(record!.id);
    }
  });
}

if (process.env.UI_AUDIT_PHASE === "clutter") {
  const stamp = Date.now();
  const messages: Pick<typeof assistantMessages.$inferInsert, "role" | "content" | "tool" | "status" | "toolResult">[] = [
    { role: "tool", tool: "set_brief", status: "ok", content: briefText, toolResult: { display: briefText, summary: briefText } },
    { role: "event", content: "Progress updated", toolResult: { data: { retry: true } } },
    { role: "tool", tool: "check_setup", status: "ok", content: "Connections checked" },
    { role: "assistant", content: briefText.replace("Noted the", "Noted  the") },
    { role: "assistant", content: "Which offer should I mention?" },
    { role: "tool", tool: "web_search", status: "error", content: "Fixture source unavailable" },
    { role: "assistant", content: "Research is ready for your review." },
  ];
  for (const [index, item] of messages.entries()) {
    await db.insert(assistantMessages).values({ organizationId: org!.id, threadId: thread!.id, ...item, createdAt: new Date(stamp + index * 1000) });
  }
  const { runInOrganization } = await import("@/lib/tenancy/scope");
  const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
  const { people } = await import("@/lib/leads/schema");
  const { crmRecords, crmConversations, crmConversationMessages } = await import("@/lib/crm/schema");
  const { and, eq } = await import("drizzle-orm");
  await runInOrganization(org!.id, async () => {
    const organizationId = org!.id;
    const { pipelineId } = await ensureCrmDefaults();
    const [person] = await db.insert(people).values({ organizationId, source: "list", fullName: "Email preview prospect", email: `preview-${stamp}@example.test` }).returning();
    const [record] = await db.insert(crmRecords).values({ organizationId, personId: person!.id, pipelineId, categoryKey: "other", categorySource: "human", workflowState: "action_required", activeChannel: "email", lastInboundAt: new Date(), lastInteractionAt: new Date() }).returning();
    emailRecordId = record!.id;
    const accountRef = `preview-${organizationId}@example.test`;
    const [conversation] = await db.insert(crmConversations).values({ organizationId, crmRecordId: record!.id, personId: person!.id, channel: "email", accountRef, providerThreadId: `ui-${record!.id}` }).returning();
    const [inbound] = await db.insert(crmConversationMessages).values({ conversationId: conversation!.id, personId: person!.id, channel: "email", accountRef, direction: "inbound", idempotencyKey: `ui-${record!.id}`, bodyText: "hi bro\n\nOn Wed, 21 Oct, previous@example.test wrote:\n> OLDER_QUOTED_THREAD_ONLY\n> Earlier sales pitch", sentAt: new Date() }).returning();
    await db.update(crmRecords).set({ latestInboundMessageId: inbound!.id }).where(and(eq(crmRecords.organizationId, organizationId), eq(crmRecords.id, record!.id)));
  });
}
writeFileSync(process.env.UI_AUDIT_FIXTURE ?? "/tmp/agentsdr-ui-audit-fixture.json", JSON.stringify({ email, password, organizationId: org!.id, userId: user!.id, threadId: thread!.id, requestId: message!.id, classificationRecords, emailRecordId, briefText }));
console.log("Local UI owner and saved request seeded");
process.exit(0);
