/**
 * Why a WhatsApp reply got no answer: follows one reply through every step
 * (Unipile's webhook registration → a delivery reaching this server → the
 * message stored as the lead's → the CRM → a draft → the reply autopilot)
 * and says where it stopped, in plain words. Read-only: it changes nothing
 * and prints no secret; phone numbers are shown by their last four digits.
 *
 * Run inside the app container (no packages; Bun's built-in client), from
 * the checkout on the server:
 *   docker cp scripts/diagnose-whatsapp-replies.ts <app container>:/tmp/diagnose.ts
 *   docker exec <app container> agentsdr-entrypoint bun /tmp/diagnose.ts
 * From source: bun scripts/diagnose-whatsapp-replies.ts
 */
import { SQL } from "bun";

const DAYS = 7;
// Printed as it goes, so whatever was found is shown even if a later step fails.
const say = (text = "") => console.log(text);
const last4 = (value: unknown) => (typeof value === "string" && value.replace(/\D/g, "").length >= 4 ? `…${value.replace(/\D/g, "").slice(-4)}` : "unknown");
const short = (value: unknown, max = 70) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const when = (value: unknown) => (value ? new Date(value as string).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");

type Row = Record<string, unknown>;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = new SQL(url, { max: 1, tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false } });
  const problems: string[] = [];
  try {
    const publicUrl = (process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
    say(`Public address of this server: ${publicUrl || "NOT SET"}`);
    if (!publicUrl || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(publicUrl)) problems.push("APP_URL is not the public https address, so Unipile cannot send replies here. Set APP_URL in .env to https://<your address> and restart.");
    else if (!publicUrl.startsWith("https://")) problems.push(`APP_URL is ${publicUrl} (not https). Unipile needs a public https address.`);

    const orgs = await sql<Row[]>`
      select distinct o.id, o.name from organizations o
      join whatsapp_accounts a on a.organization_id = o.id order by o.name`;
    if (!orgs.length) {
      say("No WhatsApp number is linked in any organization (Settings → WhatsApp → Connection → Sync from Unipile).");
      problems.push("No WhatsApp number is linked.");
    }

    for (const org of orgs) {
      const orgId = String(org.id);
      say("");
      say(`=== Organization: ${org.name} ===`);
      try {

      // 1. Webhook registration at Unipile (what saving the Unipile connection did).
      const [unipile] = await sql<Row[]>`select config from grid_providers where organization_id = ${orgId} and key = 'platform-unipile' limit 1`;
      const hooks = ((unipile?.config ?? {}) as Row).webhooks as Row | undefined;
      if (!unipile) {
        say("1. Unipile connection: NOT CONNECTED");
        problems.push(`${org.name}: Unipile is not connected (Settings → WhatsApp → Connection).`);
      } else if (!hooks) {
        say("1. Webhooks at Unipile: never registered");
        problems.push(`${org.name}: Unipile webhooks were never registered. Open Settings → WhatsApp → Connection and press "Register again" (or save the connection).`);
      } else {
        const items = Array.isArray(hooks.items) ? (hooks.items as Row[]).map((item) => item.key).join(", ") : "";
        say(`1. Webhooks at Unipile: ${hooks.status} on ${when(hooks.at)} for ${hooks.origin ?? "no address"}${items ? ` (${items})` : ""}${hooks.message ? ` — ${short(hooks.message, 200)}` : ""}`);
        if (hooks.status !== "registered") problems.push(`${org.name}: Unipile webhooks are not registered (${hooks.status}: ${short(hooks.message, 160)}). Fix the address, then press "Register again" in Settings → WhatsApp → Connection.`);
        else if (publicUrl && hooks.origin && String(hooks.origin).replace(/\/+$/, "") !== publicUrl) problems.push(`${org.name}: webhooks were registered for ${hooks.origin}, but this server is now ${publicUrl}. Press "Register again" in Settings → WhatsApp → Connection.`);
        else if (Array.isArray(hooks.items) && !(hooks.items as Row[]).some((item) => item.key === "unipile-message")) problems.push(`${org.name}: the messages webhook is missing. Press "Register again".`);
      }

      // 2. The numbers that send.
      const accounts = await sql<Row[]>`select id, unipile_account_id, phone, status, name from whatsapp_accounts where organization_id = ${orgId}`;
      say(`2. WhatsApp numbers linked: ${accounts.map((a) => `${last4(a.phone)} (${a.status})`).join(", ") || "none"}`);
      const accountPhones = new Set(accounts.map((a) => String(a.phone ?? "").replace(/\D/g, "").slice(-10)).filter(Boolean));

      // 3. Deliveries from Unipile that reached this server.
      const deliveries = await sql<Row[]>`
        select event, count(*)::int as n, max("createdAt") as latest from "WebhookEvent"
        where "organizationId" = ${orgId} and "accountType" = 'WHATSAPP' and "createdAt" > now() - make_interval(days => ${DAYS})
        group by event order by event`;
      const received = deliveries.find((d) => d.event === "message_received");
      say(`3. WhatsApp deliveries from Unipile in the last ${DAYS} days: ${deliveries.map((d) => `${d.event} ${d.n} (latest ${when(d.latest)})`).join("; ") || "NONE"}`);
      if (!received) problems.push(`${org.name}: no WhatsApp message has reached this server from Unipile in ${DAYS} days. Unipile is not calling this server: press "Register again" in Settings → WhatsApp → Connection, check the address it shows is your https address, then reply again from the phone.`);
      const recent = await sql<Row[]>`
        select "createdAt", "processingStatus", "processingLog", "senderId", "messageText" from "WebhookEvent"
        where "organizationId" = ${orgId} and "accountType" = 'WHATSAPP' and event = 'message_received'
        order by "createdAt" desc limit 3`;
      for (const row of recent) {
        const log = Array.isArray(row.processingLog) ? (row.processingLog as Row[]).map((entry) => short(entry.message ?? entry.msg ?? entry.text ?? JSON.stringify(entry), 110)).slice(-3).join(" | ") : "";
        say(`   - ${when(row.createdAt)} ${row.processingStatus ?? "?"}: "${short(row.messageText, 50)}" ${log ? `→ ${log}` : ""}`);
      }

      // 4. Stored messages: from the lead, or typed on the business phone.
      const stored = await sql<Row[]>`
        select m.origin, count(*)::int as n, max(m.sent_at) as latest from whatsapp_messages m
        join whatsapp_chats c on c.id = m.chat_id join whatsapp_accounts a on a.id = c.account_id
        where a.organization_id = ${orgId} and m.sent_at > now() - make_interval(days => ${DAYS})
        group by m.origin`;
      const byOrigin = Object.fromEntries(stored.map((s) => [String(s.origin), s]));
      say(`4. Messages stored in the last ${DAYS} days: sent by AgentSDR ${byOrigin.agentsdr?.n ?? 0}, from leads ${byOrigin.lead?.n ?? 0}, typed on the business phone ${byOrigin.phone?.n ?? 0}`);
      const selfChats = await sql<Row[]>`
        select c.phone from whatsapp_chats c join whatsapp_accounts a on a.id = c.account_id
        where a.organization_id = ${orgId} and c.phone is not null and c.last_message_at > now() - make_interval(days => ${DAYS})`;
      const toSelf = selfChats.filter((c) => accountPhones.has(String(c.phone).replace(/\D/g, "").slice(-10)));
      if (toSelf.length) problems.push(`${org.name}: you messaged the business number itself (${last4(toSelf[0]!.phone)}). In that chat every message you type counts as the business's own message, never as a lead's reply, so nothing is answered. Test with a different phone (a friend's or a second number) as the lead.`);
      else if (received && !byOrigin.lead && byOrigin.phone) problems.push(`${org.name}: the replies arrived as messages typed on the business phone, not from a lead. Reply from a different phone than the one linked in Unipile.`);

      // 5. The lead's reply on the CRM, its draft, and what the autopilot decided.
      const replies = await sql<Row[]>`
        select m.id, m.sent_at, m.body_text, m.person_id, m.conversation_id, p.full_name, p.phone
        from crm_conversation_messages m join crm_conversations c on c.id = m.conversation_id
        left join people p on p.id = m.person_id
        where c.organization_id = ${orgId} and m.channel = 'whatsapp' and m.direction = 'inbound' and m.sent_at > now() - make_interval(days => ${DAYS})
        order by m.sent_at desc limit 3`;
      if (byOrigin.lead && !replies.length) {
        const orphan = await sql<Row[]>`
          select count(*)::int as n from whatsapp_messages m join whatsapp_chats c on c.id = m.chat_id join whatsapp_accounts a on a.id = c.account_id
          where a.organization_id = ${orgId} and m.origin = 'lead' and c.person_id is null and m.sent_at > now() - make_interval(days => ${DAYS})`;
        problems.push(`${org.name}: replies were stored but never reached the CRM${Number(orphan[0]?.n ?? 0) ? ` (${orphan[0]!.n} from a chat with no matching lead: the number that replied is not a lead in AgentSDR)` : ""}.`);
      }
      say(`5. Lead replies on the CRM in the last ${DAYS} days: ${replies.length ? "" : "none"}`);
      for (const reply of replies) {
        say(`   • ${when(reply.sent_at)} from ${reply.full_name ?? "a lead"} (${last4(reply.phone)}): "${short(reply.body_text, 60)}"`);
        const [draft] = await sql<Row[]>`select id, status, revision, error, ai_body_text from crm_drafts where reply_for_message_id = ${reply.id} order by created_at desc limit 1`;
        const [classification] = await sql<Row[]>`select status, applied_category_key, error from crm_classifications where message_id = ${reply.id} order by created_at desc limit 1`;
        say(`     classified: ${classification ? `${classification.status}${classification.applied_category_key ? ` (${classification.applied_category_key})` : ""}${classification.error ? ` — ${short(classification.error, 120)}` : ""}` : "not yet"}`);
        say(`     answer written: ${draft ? `${draft.status}${draft.error ? ` — ${short(draft.error, 160)}` : ""}${draft.ai_body_text ? ` "${short(draft.ai_body_text, 60)}"` : ""}` : "no"}`);
        const run = await sql<Row[]>`
          select r.name, r.status, r.autopilot, l.status as lead_status from outreach_run_leads l join outreach_runs r on r.id = l.run_id
          where l.organization_id = ${orgId} and l.person_id = ${reply.person_id} and l.channel = 'whatsapp' order by r.created_at desc limit 1`;
        say(`     outreach run: ${run[0] ? `"${short(run[0].name, 40)}" ${run[0].status}, ${run[0].autopilot ? "Automatic replies" : "Review mode"}, lead ${run[0].lead_status}` : "none (not from an assistant outreach run)"}`);
        if (draft) {
          const [auto] = await sql<Row[]>`select status, reason, created_at from autopilot_replies where draft_id = ${draft.id} order by created_at desc limit 1`;
          const [job] = await sql<Row[]>`select status, run_after, last_error from crm_jobs where kind = 'auto_send' and entity_id = ${draft.id} order by created_at desc limit 1`;
          say(`     automatic reply: ${auto ? `${auto.status}${auto.reason ? ` — ${short(auto.reason, 200)}` : ""}` : job ? `job ${job.status}, due ${when(job.run_after)}${job.last_error ? ` — ${short(job.last_error, 160)}` : ""}` : "not queued"}`);
          if (!run[0]) problems.push(`${org.name}: the reply from ${reply.full_name ?? "the lead"} is not part of an assistant outreach run, so it waits in Action required instead of being answered automatically.`);
          else if (!run[0].autopilot) problems.push(`${org.name}: the run "${short(run[0].name, 40)}" is in Review mode, so replies wait for you in Action required. Switch it to Automatic on its plan card.`);
          else if (run[0].status !== "running") problems.push(`${org.name}: the run "${short(run[0].name, 40)}" is ${run[0].status}; automatic replies only go out while it runs.`);
          else if (draft.status === "failed") problems.push(`${org.name}: the answer could not be written (${short(draft.error, 160)}). Check Settings → AI provider.`);
          else if (auto?.status === "held") problems.push(`${org.name}: the automatic reply was held: ${short(auto.reason, 200)}${String(auto.reason ?? "").startsWith("handover") ? "" : " (see Needs you on Results)"}.`);
          else if (!auto && job && ["queued", "running"].includes(String(job.status))) problems.push(`${org.name}: the answer is queued and goes out at ${when(job.run_after)} (the 10-minute wait). Nothing is broken; check again after that time.`);
        } else if (!classification) {
          problems.push(`${org.name}: the reply reached the CRM but was not read yet. The CRM worker may not be running, or Settings → AI provider is not connected.`);
        }
      }
      } catch (error) {
        say(`   (this check stopped early: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
  } finally {
    await sql.close();
  }

  say("");
  if (problems.length) {
    say("WHAT IS WRONG (first one first):");
    problems.forEach((problem, index) => say(`${index + 1}. ${problem}`));
  } else {
    say("No problem found in the records. Reply again from a different phone and run this once more.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
