/**
 * Email through Unipile, end to end against the database, with Unipile's API
 * replaced by a recording stand-in (global fetch is intercepted for one fake
 * host; nothing leaves the machine). It runs the real code: the mailbox sync
 * from Unipile's account list, the campaign send tick with the real
 * dispatcher (no injected sender), follow-up threading by reply_to, the
 * email webhook's gate, an inbound reply stopping follow-ups through the real
 * CRM ingestion, and a CRM reply sent as a Unipile reply (with the fallback
 * when Unipile no longer knows the email it answers).
 *
 *   bun run --conditions=react-server scripts/e2e/unipile-email.ts
 *
 * What it cannot prove: that the real Unipile accepts these exact requests
 * and delivers them. The request shapes follow Unipile's API reference and
 * unipile-node-sdk 1.9.3; the live check is in docs/product/OWNER_SETUP.md.
 *
 * It creates its own organization ("Unipile email check …") and leaves it
 * behind with its campaign paused, its mailboxes disabled and its fake
 * Unipile connection removed. Refuses a non-local DATABASE_URL, and refuses
 * to tick while any other organization has a queued email (the tick is
 * global).
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { NextRequest } from "next/server";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

// ------------------------------------------------------------ fake Unipile
const FAKE = "https://unipile-email-check.invalid";
const NOTIFY_SECRET = "email-check-secret";
type Recorded = { method: string; path: string; form: Record<string, string> };
const requests: Recorded[] = [];
let accounts: Record<string, unknown>[] = [];
const storedEmails = new Map<string, Record<string, unknown>>();
let sendCount = 0;
const runId = Date.now().toString(36);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== FAKE) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const form: Record<string, string> = {};
  if (init?.body instanceof FormData) for (const [key, value] of init.body.entries()) form[key] = String(value);
  requests.push({ method, path: url.pathname, form });
  const path = url.pathname.replace(/^\/api\/v1/, "");

  if (method === "GET" && path === "/accounts") return json(200, { object: "AccountList", items: accounts, cursor: null });
  const accountMatch = path.match(/^\/accounts\/([^/]+)$/);
  if (method === "GET" && accountMatch) {
    const account = accounts.find((a) => a.id === accountMatch[1]);
    return account ? json(200, account) : json(404, { title: "Not found", status: 404, type: "errors/resource_not_found" });
  }
  if (method === "POST" && path === "/emails") {
    if (form.reply_to === "gone-from-unipile") return json(404, { title: "Email not found", status: 404, type: "errors/resource_not_found" });
    if (JSON.parse(form.to ?? "[]")[0]?.identifier === "refused@example.test") {
      return json(400, { title: "Invalid recipient", detail: "The recipient address was rejected.", status: 400, type: "errors/invalid_parameters" });
    }
    sendCount += 1;
    // Unique per run: outreach_emails.gmail_message_id is unique across every mailbox.
    return json(201, { object: "EmailSent", tracking_id: `trk-${runId}-${sendCount}`, provider_id: `prov-${runId}-${sendCount}` });
  }
  const emailMatch = path.match(/^\/emails\/([^/]+)$/);
  if (method === "GET" && emailMatch) {
    const email = storedEmails.get(emailMatch[1]!);
    return email ? json(200, email) : json(404, { title: "Not found", status: 404, type: "errors/resource_not_found" });
  }
  if (path.startsWith("/webhooks")) return method === "POST" ? json(201, { object: "WebhookCreated", webhook_id: "wh-1" }) : json(200, { items: [] });
  return json(404, { title: `No fake for ${method} ${path}`, status: 404 });
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { people } = await import("@/lib/leads/schema");
const { mailboxes, outreachEmails, outreachLeads, outreachMailboxQueue } = await import("@/lib/outreach/schema");
const { createCampaign, emailLaunchFacts, setCampaignStatus, updateCampaignSequence } = await import("@/lib/outreach/campaigns");
const { emailLaunchProblems, parseSequence } = await import("@/lib/outreach/launch");
const { buildMailboxQueues } = await import("@/lib/outreach/buildQueue");
const { runSchedulerTick } = await import("@/lib/outreach/scheduler");
const { syncUnipileMailboxes } = await import("@/lib/outreach/mailboxProviders");
const { retestMailbox } = await import("@/lib/outreach/mailboxes");
const { ingestUnipileEmail } = await import("@/lib/outreach/unipileInbound");
const { unipileReplyTarget } = await import("@/lib/outreach/unipileMail");
const { sendThroughCrmProvider } = await import("@/lib/crm/send");
const { crmConversationMessages, crmConversations } = await import("@/lib/crm/schema");
const { inboundEvents } = await import("@/lib/inbox/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { createStepLogger } = await import("@/lib/debugLog");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { POST: emailWebhook } = await import("@/app/api/webhooks/unipile-email/route");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Unipile email check ${stamp}`, slug: `unipile-email-check-${stamp}` }).returning();
console.log(`Organization ${org!.name} (${org!.id})`);

const gmailAddress = `owner-${stamp}@gmail.example.test`;
const outlookAddress = `sales-${stamp}@outlook.example.test`;
const leadAddress = `ada-${stamp}@example.test`;
const ALL_DAY = { enabled: true, from: "00:00", to: "23:59" };
const week = { monday: ALL_DAY, tuesday: ALL_DAY, wednesday: ALL_DAY, thursday: ALL_DAY, friday: ALL_DAY, saturday: ALL_DAY, sunday: ALL_DAY };
const gmailAccount = {
  object: "Account", type: "GOOGLE_OAUTH", id: `gmail-${stamp}`, name: "Ravi (check)",
  connection_params: { mail: { id: "1", username: gmailAddress } }, sources: [{ id: "s1", status: "OK" }],
};
const outlookAccount = {
  object: "Account", type: "OUTLOOK", id: `outlook-${stamp}`, name: outlookAddress,
  connection_params: { mail: { id: "2", username: outlookAddress } }, sources: [{ id: "s2", status: "CREDENTIALS" }],
};
accounts = [
  gmailAccount,
  outlookAccount,
  { object: "Account", type: "LINKEDIN", id: `li-${stamp}`, name: "Someone", connection_params: { im: {} }, sources: [{ status: "OK" }] },
  { object: "Account", type: "MAIL", id: `imap-${stamp}`, name: "No address", connection_params: { mail: {} }, sources: [{ status: "OK" }] },
];

await runInOrganization(org!.id, async () => {
  const [provider] = await db.insert(gridProviders).values({ organizationId: currentOrganizationId(), key: "platform-unipile", name: "Unipile (email check)" }).returning();
  await db.insert(gridProviderCredentials).values({
    providerId: provider!.id,
    encryptedPayload: encryptIntegrationCredentials({ baseUrl: FAKE, apiKey: "email-check", notifySecret: NOTIFY_SECRET }),
  });

  try {
    // ------------------------------------------------------------ mailbox sync
    const synced = await syncUnipileMailboxes();
    check(
      "sync makes each linked inbox a mailbox, skips one without an address, ignores LinkedIn",
      synced.synced.length === 2 && synced.synced.every((m) => m.added) && synced.skipped.length === 1 && synced.skipped[0]!.reason.includes("no email address"),
      JSON.stringify(synced),
    );
    const rows = await db.select().from(mailboxes).where(eq(mailboxes.organizationId, currentOrganizationId()));
    const gmail = rows.find((m) => m.emailAddress === gmailAddress);
    const outlook = rows.find((m) => m.emailAddress === outlookAddress);
    check("the Gmail inbox is a connected Unipile mailbox", gmail?.provider === "unipile" && gmail.unipileAccountId === gmailAccount.id && gmail.status === "connected" && gmail.displayName === "Ravi (check)");
    check("the Outlook inbox Unipile lost access to is failed, with the reason", outlook?.status === "failed" && Boolean(outlook.lastError?.includes("reconnect")), outlook?.lastError ?? "");

    const again = await syncUnipileMailboxes();
    const rowsAgain = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.organizationId, currentOrganizationId()));
    check("syncing again adds nothing", again.synced.every((m) => !m.added) && rowsAgain.length === 2);

    accounts = accounts.filter((a) => a.id !== outlookAccount.id);
    const afterUnlink = await syncUnipileMailboxes();
    check("an inbox gone from Unipile is reported (already failed, so not re-marked)", afterUnlink.synced.length === 1, JSON.stringify(afterUnlink));
    const retest = await retestMailbox(outlook!.id);
    check("testing a mailbox whose inbox is gone says so", !retest.ok && "error" in retest && retest.error.includes("no longer linked"), JSON.stringify(retest));
    const retestGmail = await retestMailbox(gmail!.id);
    check("testing the Gmail mailbox re-reads its Unipile account", retestGmail.ok && requests.some((r) => r.method === "GET" && r.path === `/api/v1/accounts/${gmailAccount.id}`));

    // ------------------------------------------------------------ webhook gate
    const hook = (secret: string | null, body: Record<string, unknown>) => emailWebhook(new NextRequest(`http://localhost/api/webhooks/unipile-email?org=${currentOrganizationId()}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-unipile-secret": secret } : {}) },
      body: JSON.stringify(body),
    }));
    const wrong = await hook("not-the-secret", { event: "mail_received", account_id: gmailAccount.id, email_id: "x" });
    check("the email webhook refuses a wrong secret", wrong.status === 401);
    const stranger = await hook(NOTIFY_SECRET, { event: "mail_received", account_id: "someone-elses-account", email_id: "x" });
    check("the email webhook acknowledges and drops an account that is not a mailbox here", stranger.status === 200 && (await stranger.json()).skipped === true);
    const moved = await hook(NOTIFY_SECRET, { event: "mail_moved", account_id: gmailAccount.id, email_id: "x" });
    check("the email webhook drops events other than mail_received", moved.status === 200 && (await moved.json()).skipped === true);

    // ------------------------------------------------------------ campaign send
    const campaign = await createCampaign({ name: "Unipile email check" });
    const parsed = parseSequence([
      { subject: "Hello {{firstName}}", body: "First email", waitDays: 0 },
      { subject: "", body: "Following up", waitDays: 0 },
      { subject: "", body: "Last note", waitDays: 3 },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    await updateCampaignSequence(campaign.id, parsed.sequence);
    const [person] = await db.insert(people).values({ organizationId: currentOrganizationId(), email: leadAddress, firstName: "Ada", source: "unipile-email-check" }).returning();
    const [lead] = await db.insert(outreachLeads).values({ personId: person!.id, campaignId: campaign.id }).returning();

    const problems = emailLaunchProblems(await emailLaunchFacts({ id: campaign.id, sequence: parsed.sequence }));
    check("a Unipile mailbox satisfies the launch rules without Google Workspace", problems.length === 0, JSON.stringify(problems));

    await db.update(mailboxes).set({ workingHours: { timezone: "UTC", days: week }, nextEmailTime: null }).where(eq(mailboxes.id, gmail!.id));
    await setCampaignStatus(campaign.id, "active");
    const otherQueues = await db.select({ n: sql<number>`count(*)::int` }).from(outreachMailboxQueue)
      .innerJoin(mailboxes, eq(outreachMailboxQueue.mailboxId, mailboxes.id))
      .where(ne(mailboxes.organizationId, currentOrganizationId()));
    if (Number(otherQueues[0]?.n ?? 0) > 0) throw new Error("Another organization has queued emails; the send tick is global, so this check stops here.");

    await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
    const first = await runSchedulerTick();
    const firstSend = requests.filter((r) => r.method === "POST" && r.path === "/api/v1/emails").at(-1);
    check("the tick sends the first email through Unipile with the real dispatcher", first.sent === 1 && Boolean(firstSend), JSON.stringify(first));
    check(
      "it goes from the linked account to the lead, with the subject filled and the unsubscribe link in the body",
      firstSend?.form.account_id === gmailAccount.id
        && JSON.parse(firstSend.form.to ?? "[]")[0]?.identifier === leadAddress
        && firstSend.form.subject === "Hello Ada"
        && /unsubscribe/i.test(firstSend.form.body ?? "")
        && firstSend.form.reply_to === undefined,
      JSON.stringify(firstSend?.form),
    );
    const [sentRow] = await db.select().from(outreachEmails).where(and(eq(outreachEmails.leadId, lead!.id), eq(outreachEmails.stepNumber, 1)));
    check(
      "the sent email keeps Unipile's provider id (prefixed with the account), for threading",
      sentRow?.status === "sent" && sentRow.gmailMessageId === `unipile:${gmailAccount.id}:prov-${runId}-1`,
      sentRow?.gmailMessageId ?? sentRow?.error ?? "",
    );

    await db.update(outreachLeads).set({ nextSendAt: new Date(Date.now() - 60_000) }).where(eq(outreachLeads.id, lead!.id));
    await buildMailboxQueues({ organizationIds: [currentOrganizationId()] });
    await db.update(mailboxes).set({ nextEmailTime: null }).where(eq(mailboxes.id, gmail!.id));
    const second = await runSchedulerTick();
    const followUp = requests.filter((r) => r.method === "POST" && r.path === "/api/v1/emails").at(-1);
    check(
      "the follow-up with a blank subject is sent as a reply to the first (reply_to = its provider id)",
      second.sent === 1 && followUp !== firstSend && followUp?.form.reply_to === `prov-${runId}-1` && followUp.form.subject === "Re: Hello Ada",
      JSON.stringify(followUp?.form),
    );

    // ------------------------------------------------------------ inbound reply
    const reply = {
      email_id: `uni-in-${stamp}`,
      account_id: gmailAccount.id,
      event: "mail_received",
      date: new Date().toISOString(),
      from_attendee: { display_name: "Ada", identifier: leadAddress, identifier_type: "EMAIL_ADDRESS" },
      to_attendees: [{ identifier: gmailAddress }],
      subject: "Re: Hello Ada",
      body: "<p>Interested, call me Tuesday.</p>",
      body_plain: "Interested, call me Tuesday.",
      message_id: `reply-${stamp}@mail.example.test`,
      provider_id: `gm-${stamp}`,
      role: "inbox",
      origin: "external",
    };
    const log = createStepLogger();
    const outcome = await ingestUnipileEmail(reply, log);
    const [leadAfter] = await db.select().from(outreachLeads).where(eq(outreachLeads.id, lead!.id));
    check("a reply from the lead (one follow-up still due) is filed and stops the follow-ups", outcome === "ok" && leadAfter?.sequenceStatus === "reply_received" && leadAfter.nextSendAt === null, `${outcome} ${leadAfter?.sequenceStatus} ${log.steps.map((s) => s.message).join(" | ")}`);
    const [diagnostic] = await db.select().from(inboundEvents).where(and(eq(inboundEvents.organizationId, currentOrganizationId()), eq(inboundEvents.source, "unipile")));
    check("the processing log is kept with the inbound diagnostics", diagnostic?.status === "ok");

    const duplicate = await ingestUnipileEmail(reply, createStepLogger());
    check("the same email delivered again is not filed twice", duplicate === "skipped");

    const [conversation] = await db.select().from(crmConversations)
      .where(and(eq(crmConversations.organizationId, currentOrganizationId()), eq(crmConversations.accountRef, gmailAddress)));
    const history = conversation
      ? await db.select({ raw: crmConversationMessages.raw, providerMessageId: crmConversationMessages.providerMessageId })
        .from(crmConversationMessages).where(eq(crmConversationMessages.conversationId, conversation.id))
        .orderBy(crmConversationMessages.sentAt, crmConversationMessages.id)
      : [];
    const target = unipileReplyTarget(history);
    check("the CRM conversation remembers Unipile's id of the reply, for answering it", target === reply.email_id, `${target} of ${history.length} messages`);

    storedEmails.set(`uni-bodyless-${stamp}`, { ...reply, id: `uni-bodyless-${stamp}`, email_id: undefined, provider_id: `gm2-${stamp}`, body_plain: "Fetched in full." });
    const bodyless = createStepLogger();
    await ingestUnipileEmail({ ...reply, email_id: `uni-bodyless-${stamp}`, provider_id: `gm2-${stamp}`, body: "", body_plain: "", is_complete: false }, bodyless);
    check("a delivery without its body is read in full from Unipile", requests.some((r) => r.method === "GET" && r.path === `/api/v1/emails/uni-bodyless-${stamp}`));

    // ------------------------------------------------------------ CRM reply
    const request = {
      channel: "email" as const,
      accountRef: gmailAddress,
      providerThreadId: conversation?.providerThreadId ?? null,
      providerContactId: leadAddress,
      recipientEmail: leadAddress,
      subject: "Re: Hello Ada",
      bodyText: "Tuesday works. Talk then.",
      bodyHtml: null,
      inReplyTo: null,
      providerReplyTo: target,
    };
    const crmSent = await sendThroughCrmProvider(request);
    const crmRequest = requests.filter((r) => r.method === "POST" && r.path === "/api/v1/emails").at(-1);
    check(
      "a reviewed CRM reply goes through Unipile as a reply to the lead's email",
      crmSent.provider === "unipile" && crmRequest?.form.reply_to === reply.email_id && crmRequest.form.account_id === gmailAccount.id && (crmRequest.form.body ?? "").includes("Tuesday works."),
      JSON.stringify(crmRequest?.form),
    );
    const before = requests.length;
    const fallback = await sendThroughCrmProvider({ ...request, providerReplyTo: "gone-from-unipile" });
    const attempts = requests.slice(before).filter((r) => r.method === "POST" && r.path === "/api/v1/emails");
    check(
      "when Unipile no longer knows that email, the reply is sent on its own instead of failing",
      attempts.length === 2 && attempts[0]!.form.reply_to === "gone-from-unipile" && attempts[1]!.form.reply_to === undefined && Boolean(fallback.providerMessageId),
      JSON.stringify(attempts.map((a) => a.form.reply_to ?? null)),
    );

    const refused = await sendThroughCrmProvider({ ...request, recipientEmail: "refused@example.test", providerReplyTo: null }).then(
      () => null,
      (error: unknown) => error as Error & { status?: number },
    );
    check(
      "a send Unipile refuses fails with its reason and status (a refusal, not an uncertain delivery)",
      refused?.status === 400 && refused.message === "Unipile refused the email (HTTP 400): Invalid recipient: The recipient address was rejected.",
      refused?.message ?? "no error",
    );

    await setCampaignStatus(campaign.id, "paused");
  } finally {
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.organizationId, currentOrganizationId()));
    await db.delete(gridProviders).where(eq(gridProviders.id, provider!.id));
  }
});

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
