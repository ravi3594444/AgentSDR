/* eslint-disable @typescript-eslint/no-explicit-any -- PostgreSQL and optional PGlite test adapters expose different query shapes. */
/** Disposable database replay; every provider call is replaced before the worker is imported. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
const root = join(import.meta.dir, "..");
// Always use an empty disposable database, never a deployment's DATABASE_URL.
// Optional PGlite transport: install it separately and set its module path.
const pgliteModule = process.env.INSTAGRAM_TEST_PGLITE_MODULE;
let pg: any;
let db: any;
if (pgliteModule) {
  const { PGlite } = await import(pgliteModule);
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite();
  const adapt = (database: any): any =>
    new Proxy(database, {
      get(target, key) {
        if (key === "execute")
          return async (...args: any[]) => (await target.execute(...args)).rows;
        if (key === "transaction")
          return (fn: any) => target.transaction((tx: any) => fn(adapt(tx)));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  db = adapt(drizzle(pg));
  mock.module(root + "/src/lib/db.ts", () => ({ db }));
} else {
  const url = process.env.INSTAGRAM_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "Set INSTAGRAM_TEST_DATABASE_URL to an empty local database named agentsdr_test_*",
    );
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !parsed.pathname.startsWith("/agentsdr_test_")
  )
    throw new Error("Refusing a non-local or non-test database");
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = "disable";
  const client = postgres(url, { ssl: false, max: 2 });
  pg = {
    exec: (text: string) => client.unsafe(text).simple(),
    query: async (text: string, args: any[] = []) => ({
      rows: await client.unsafe(text, args),
    }),
    close: () => client.end(),
  };
  db = (await import(root + "/src/lib/db.ts")).db;
}
await pg.exec(await readFile(root + "/db/schema.sql", "utf8"));
await pg.exec(await readFile(root + "/db/seed.sql", "utf8"));
await pg.exec("set search_path to public");

const credentials = await import(root + "/src/lib/platform/credentials.ts");
mock.module(root + "/src/lib/platform/credentials.ts", () => ({
  ...credentials,
  isPlatformConnected: async () => true,
}));
let posts: number = 0;
let resolveHook: (() => Promise<void>) | null = null;
let postHook: (() => Promise<void>) | null = null;
let sendError: any = null;
mock.module(root + "/src/services/unipile.instagram-outreach.ts", () => ({
  resolveInstagramOutreachRecipient: async (
    _account: string,
    username: string,
  ) => {
    await resolveHook?.();
    return { username, messagingId: "dm-" + username };
  },
  startInstagramOutreachChat: async (_account: string, mid: string) => {
    posts++;
    await postHook?.();
    if (sendError) throw sendError;
    return { chatId: "chat-" + mid, messageId: "msg-" + mid };
  },
}));
const { runInOrganization } = await import(root + "/src/lib/tenancy/scope.ts");
const { queueInstagramOutreach, runInstagramOutreachTick } = await import(
  root + "/src/lib/instagram/outreach.server.ts"
);
const { upsertInstagramProspect } = await import(
  root + "/src/lib/instagram/prospects.server.ts"
);
const { ingestInstagramWebhook } = await import(
  root + "/src/lib/instagram/messages.ts"
);
const { ensureCrmDefaults } = await import(root + "/src/lib/crm/defaults.ts");
const { attachInitialInstagramEcho } = await import(
  root + "/src/lib/instagram/outreachEcho.server.ts"
);
const { instagramAccounts, instagramChats } = await import(
  root + "/src/lib/instagram/schema.ts"
);
const { eq } = await import(root + "/node_modules/drizzle-orm/index.js");
const { diagnoseDelivery } = await import(
  root + "/src/lib/assistant/deliveryDiagnostics.server.ts"
);
const { results } = await import(root + "/src/lib/assistant/results.server.ts");
const { reportRun } = await import(
  root + "/src/lib/assistant/outreach.server.ts"
);
const { runLeads } = await import(
  root + "/src/lib/assistant/runLeads.server.ts"
);
const { saveChannelRules } = await import(
  root + "/src/lib/channels/rules.server.ts"
);
const { setFeature } = await import(root + "/src/lib/features/flags.server.ts");
let cases = 0;
async function fixture(
  name: string,
  opts: { cap?: number; ruleCap?: number } = {},
) {
  const ids = Object.fromEntries(
    ["org", "audience", "run", "person", "account", "approver"].map((k) => [
      k,
      crypto.randomUUID(),
    ]),
  ) as Record<
    "org" | "audience" | "run" | "person" | "account" | "approver",
    string
  >;
  await pg.query("insert into organizations(id,name,slug) values($1,$2,$3)", [
    ids.org,
    name,
    ids.org,
  ]);
  await pg.query(
    "insert into organization_features(organization_id,key,enabled) values($1,'instagram',true)",
    [ids.org],
  );
  await pg.query(
    "insert into channel_settings(organization_id,channel,values) values($1,'instagram',$2)",
    [
      ids.org,
      {
        newChatsPerDay: opts.ruleCap ?? 10,
        sendGapMinutes: [1, 1],
        sendingHours: null,
      },
    ],
  );
  await pg.query(
    "insert into people(id,organization_id,full_name,raw,source) values($1,$2,$3,$4,'fixture')",
    [ids.person, ids.org, name, { instagram: { username: name } }],
  );
  await pg.query(
    "insert into lead_audiences(id,organization_id,name,source) values($1,$2,$3,'list')",
    [ids.audience, ids.org, name],
  );
  const plan = {
    assignments: [{ personId: ids.person, channel: "instagram" }],
    limits: { instagramNewChatsPerDay: opts.cap ?? 10 },
  };
  await pg.query(
    "insert into outreach_runs(id,organization_id,audience_id,name,status,channels,plan,approved_by,approved_at) values($1,$2,$3,$4,'starting',ARRAY['instagram'],$5,$6,now())",
    [ids.run, ids.org, ids.audience, name, plan, ids.approver],
  );
  await pg.query(
    "insert into outreach_run_leads(organization_id,run_id,person_id,channel) values($1,$2,$3,'instagram')",
    [ids.org, ids.run, ids.person],
  );
  await pg.query(
    "insert into instagram_accounts(id,organization_id,unipile_account_id,username,status) values($1,$2,$3,'sender','connected')",
    [ids.account, ids.org, ids.account],
  );
  const leads = [
    { personId: ids.person, username: name, body: "Hello " + name },
  ];
  const scope = (fn: () => any) => runInOrganization(ids.org, fn);
  await scope(() => queueInstagramOutreach(ids.run, leads, [ids.account]));
  await scope(() => queueInstagramOutreach(ids.run, leads, [ids.account]));
  assert.equal(
    (
      await pg.query(
        "select count(*)::int n from instagram_outreach_queue where run_id=$1",
        [ids.run],
      )
    ).rows[0].n,
    1,
  );
  await pg.query(
    "update outreach_runs set status='running',campaigns=$2 where id=$1",
    [ids.run, { instagram: ids.run }],
  );
  const status = async () =>
    (
      await pg.query("select * from instagram_outreach_queue where run_id=$1", [
        ids.run,
      ])
    ).rows[0] as any;
  const finish = async () => {
    await pg.query("update outreach_runs set status='stopped' where id=$1", [
      ids.run,
    ]);
    cases++;
    console.log("PASS", name);
  };
  return { ...ids, leads, scope, status, finish };
}
try {
  const success = await fixture("success");
  await runInstagramOutreachTick();
  assert.equal((await success.status()).status, "sent");
  assert.equal(posts, 1);
  await runInstagramOutreachTick();
  assert.equal(posts, 1);
  const report = await success.scope(() => reportRun(success.run));
  assert.equal(report!.channels[0].messagesSent, 1);
  assert.equal(
    (await success.scope(() => runLeads([success.run])))[success.run][0]
      .progress.tone,
    "sent",
  );
  const metrics = await success.scope(() => results("today"));
  assert.equal(metrics.outreach.instagramSent, 1);
  assert.equal(metrics.outreach.peopleContacted, 1);
  const diag = await success.scope(() => diagnoseDelivery(success.run));
  assert.equal(diag.instagram[0].attempted24h, 1);
  await success.finish();

  const reply = await fixture("reply_without_intake");
  await reply.scope(() => ensureCrmDefaults());
  await runInstagramOutreachTick();
  assert.equal((await reply.status()).status, "sent");
  const replyAt = new Date();
  const payload = {
    event: "message_received",
    account_type: "INSTAGRAM",
    account_id: reply.account,
    chat_id: "chat-dm-reply_without_intake",
    message_id: "inbound-reply-without-intake",
    message: "Please send details",
    timestamp: replyAt.toISOString(),
    is_sender: false,
    sender: {
      attendee_provider_id: "dm-reply_without_intake",
      attendee_public_identifier: "reply_without_intake",
    },
    attendees: [
      {
        attendee_provider_id: "dm-reply_without_intake",
        attendee_public_identifier: "reply_without_intake",
      },
    ],
  };
  const entries: any[] = [];
  assert.equal(
    await reply.scope(() => ingestInstagramWebhook(payload, entries, replyAt)),
    "ok",
    JSON.stringify(entries),
  );
  await reply.scope(() => ingestInstagramWebhook(payload, entries, replyAt));
  assert.equal(
    (
      await pg.query(
        "select inquiry_intake from instagram_accounts where id=$1",
        [reply.account],
      )
    ).rows[0].inquiry_intake,
    false,
  );
  assert.equal(
    (
      await pg.query(
        "select count(*)::int n from crm_conversation_messages m join crm_conversations c on c.id=m.conversation_id where c.organization_id=$1 and m.direction='inbound'",
        [reply.org],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await reply.scope(() => reportRun(reply.run)))!.channels[0].replied,
    1,
  );
  assert.equal(
    (await reply.scope(() => runLeads([reply.run])))[reply.run][0].progress
      .text,
    "Replied",
  );
  await reply.finish();

  for (const gate of [
    "paused",
    "dnc",
    "disconnected",
    "feature_off",
    "migration_pause",
    "opted_out",
    "replied",
    "identity_conflict",
  ]) {
    const f = await fixture(gate);
    const before: number = posts;
    if (gate === "paused")
      await pg.query("update outreach_runs set status='paused' where id=$1", [
        f.run,
      ]);
    if (gate === "dnc")
      await pg.query(
        "insert into crm_person_contact_policies(person_id,do_not_contact,source,set_at) values($1,true,'human',now())",
        [f.person],
      );
    if (gate === "disconnected")
      await pg.query(
        "update instagram_accounts set status='disconnected' where id=$1",
        [f.account],
      );
    if (gate === "feature_off")
      await f.scope(() => setFeature("instagram", false, null));
    if (gate === "migration_pause")
      process.env.PAUSE_INSTAGRAM_OUTBOUND = "true";
    if (gate === "opted_out")
      await pg.query(
        "update outreach_run_leads set status='opted_out' where run_id=$1",
        [f.run],
      );
    if (gate === "replied" || gate === "identity_conflict") {
      const other = crypto.randomUUID();
      if (gate === "identity_conflict")
        await pg.query(
          "insert into people(id,organization_id,source) values($1,$2,'fixture')",
          [other, f.org],
        );
      const cid = crypto.randomUUID();
      await pg.query(
        "insert into instagram_chats(id,account_id,unipile_chat_id,provider_id,person_id,first_seen_via) values($1,$2,$3,$4,$5,'webhook')",
        [
          cid,
          f.account,
          cid,
          "dm-" + gate,
          gate === "replied" ? f.person : other,
        ],
      );
      if (gate === "replied")
        await pg.query(
          "insert into instagram_messages(chat_id,direction,origin,body,sent_at,historical) values($1,'inbound','lead','No thanks',now()+interval '1 second',false)",
          [cid],
        );
    }
    await runInstagramOutreachTick();
    assert.equal(posts, before);
    delete process.env.PAUSE_INSTAGRAM_OUTBOUND;
    await f.finish();
  }
  const stopped = await fixture("stopped_while_resolving");
  const beforeStop = posts;
  resolveHook = async () => {
    await pg.query("update outreach_runs set status='stopped' where id=$1", [
      stopped.run,
    ]);
  };
  await runInstagramOutreachTick();
  resolveHook = null;
  assert.equal(posts, beforeStop);
  assert.equal((await stopped.status()).status, "cancelled");
  await stopped.finish();

  const lost = await fixture("lost_response");
  sendError = new Error("socket closed");
  const beforeLost = posts;
  await runInstagramOutreachTick();
  sendError = null;
  assert.equal((await lost.status()).status, "uncertain");
  await runInstagramOutreachTick();
  assert.equal(posts, beforeLost + 1);
  await lost.finish();

  const refused = await fixture("refused");
  sendError = Object.assign(new Error("Recipient restricted"), { status: 422 });
  await runInstagramOutreachTick();
  sendError = null;
  assert.equal((await refused.status()).status, "failed");
  await refused.finish();

  for (const state of ["resolving", "sending"]) {
    const f = await fixture("restart_" + state);
    const before: number = posts;
    await pg.query(
      "update instagram_outreach_queue set status=$2,locked_until=now()-interval '1 minute',locked_by='dead-worker',attempted_at=case when $2='sending' then now() else null end where run_id=$1",
      [f.run, state],
    );
    await runInstagramOutreachTick();
    assert.equal(
      (await f.status()).status,
      state === "sending" ? "uncertain" : "sent",
    );
    assert.equal(posts, before + (state === "resolving" ? 1 : 0));
    await f.finish();
  }

  const gap = await fixture("send_gap");
  const beforeGap = posts;
  await pg.query(
    "update instagram_accounts set outreach_next_send_at=now()+interval '1 hour' where id=$1",
    [gap.account],
  );
  await runInstagramOutreachTick();
  assert.equal(posts, beforeGap);
  assert.equal((await gap.status()).status, "queued");
  await gap.finish();

  const hours = await fixture("hours_change");
  const beforeHours = posts;
  resolveHook = async () => {
    await hours.scope(() =>
      saveChannelRules(
        "instagram",
        {
          sendingHours: {
            timezone: "UTC",
            days: [(new Date().getUTCDay() + 1) % 7],
            start: "00:00",
            end: "23:59",
          },
        },
        null,
      ),
    );
  };
  await runInstagramOutreachTick();
  resolveHook = null;
  assert.equal(posts, beforeHours);
  assert.equal((await hours.status()).status, "queued");
  await hours.finish();

  for (const mode of ["approved_cap", "organization_cap"]) {
    const f = await fixture(mode, {
      cap: mode === "approved_cap" ? 1 : 10,
      ruleCap: mode === "organization_cap" ? 1 : 10,
    });
    const before: number = posts;
    await pg.query(
      "update instagram_outreach_queue set status='failed',attempted_at=now() where run_id=$1",
      [f.run],
    );
    const add = async (name: string, account: string) => {
      const pid = crypto.randomUUID();
      await pg.query(
        "insert into people(id,organization_id,source) values($1,$2,'fixture')",
        [pid, f.org],
      );
      await pg.query(
        "insert into outreach_run_leads(organization_id,run_id,person_id,channel) values($1,$2,$3,'instagram')",
        [f.org, f.run, pid],
      );
      await pg.query(
        "insert into instagram_outreach_queue(organization_id,run_id,person_id,account_id,username,body) values($1,$2,$3,$4,$5,$6)",
        [f.org, f.run, pid, account, name, "Hello " + name],
      );
      return pid;
    };
    await add("over_cap", f.account);
    await runInstagramOutreachTick();
    assert.equal(posts, before);
    const spare = crypto.randomUUID();
    await pg.query(
      "insert into instagram_accounts(id,organization_id,unipile_account_id,username,status) values($1,$2,$3,'spare_sender','connected')",
      [spare, f.org, spare],
    );
    await add("spare_" + mode, spare);
    await runInstagramOutreachTick();
    assert.equal(posts, before + 1);
    await f.finish();
  }

  const echo = await fixture("early_echo");
  const eventAt = new Date();
  postHook = async () => {
    await echo.scope(async () => {
      const [a] = await db
        .select()
        .from(instagramAccounts)
        .where(eq(instagramAccounts.id, echo.account));
      const [chat] = await db
        .insert(instagramChats)
        .values({
          accountId: a.id,
          unipileChatId: "echo-chat",
          providerId: "dm-early_echo",
          personId: echo.person,
          firstSeenVia: "webhook",
          lastMessageAt: new Date(eventAt.getTime() + 10_000),
          lastMessagePreview: "Newer inbound",
          lastDirection: "inbound",
        })
        .returning();
      assert.equal(
        await attachInitialInstagramEcho(a, chat, {
          isSender: true,
          attachments: [],
          counterpartyProviderId: "dm-early_echo",
          body: "Hello early_echo",
          sentAt: eventAt,
          unipileMessageId: "echo-message",
          unipileChatId: "echo-chat",
        } as any),
        true,
      );
      const [after] = await db
        .select()
        .from(instagramChats)
        .where(eq(instagramChats.id, chat.id));
      assert.equal(after.lastMessagePreview, "Newer inbound");
    });
  };
  await runInstagramOutreachTick();
  postHook = null;
  assert.equal((await echo.status()).status, "sent");
  assert.equal(
    (
      await pg.query(
        "select count(*)::int n from instagram_messages where id=$1",
        [(await echo.status()).id],
      )
    ).rows[0].n,
    1,
  );
  await echo.finish();

  const identity = await fixture("profile_dedupe");
  const person1 = await identity.scope(() =>
    db.transaction((tx: any) =>
      upsertInstagramProspect(tx, "@Profile_Dedupe", {
        source: "fixture",
        raw: { instagram: { username: "Profile_Dedupe" } },
      }),
    ),
  );
  assert.equal(person1.id, identity.person);
  assert.equal(person1.email, null);
  const newPerson = await identity.scope(() =>
    db.transaction((tx: any) =>
      upsertInstagramProspect(tx, "brand.new", {
        source: "fixture",
        raw: { instagram: { username: "Brand.New" } },
      }),
    ),
  );
  const same = await identity.scope(() =>
    db.transaction((tx: any) =>
      upsertInstagramProspect(tx, "BRAND.NEW", { source: "fixture" }),
    ),
  );
  assert.equal(newPerson.id, same.id);
  await assert.rejects(() =>
    identity.scope(() =>
      queueInstagramOutreach(success.run, identity.leads, [identity.account]),
    ),
  );
  await identity.finish();
  console.log(
    "Integration cases passed:",
    cases,
    "Provider POST attempts:",
    posts,
    "(all simulated)",
  );
} finally {
  await pg.close();
}
