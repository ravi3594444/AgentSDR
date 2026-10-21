/**
 * Northwind's email outbound: six sending mailboxes, five campaigns with
 * their sequences, three months of sent history, the replies that came back
 * (ingested through the same bridge Gmail uses, so the inbox, CRM threads and
 * analytics all agree), bounces, unsubscribes, and the inbox's own tasks and
 * notes.
 *
 * Library functions where one fits (createCampaign, addPeopleToEmailCampaign,
 * ingestGmailReply, suppressEmailOutreach, createTask, createNote); direct
 * inserts for sent history, which the app would stamp "now".
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { mailboxes, outreachCampaigns, outreachEmails, outreachLeads, suppressionList } from "@/lib/outreach/schema";
import type { CampaignStatus, OutreachLeadStatus, SequenceStep } from "@/lib/outreach/schema";
import { createCampaign, setCampaignStatus, updateCampaignSequence } from "@/lib/outreach/campaigns";
import { addPeopleToEmailCampaign } from "@/lib/leads/campaignAssignments";
import { ingestGmailReply } from "@/lib/outreach/replyBridge";
import type { InboundMessage } from "@/lib/outreach/gmail";
import { suppressEmailOutreach } from "@/lib/outreach/suppression";
import { renderEmail } from "@/lib/outreach/render";
import { alwaysOpenHours } from "@/lib/outreach/workingHours";
import { personVariables } from "@/lib/leads/variables";
import { createStepLogger } from "@/lib/debugLog";
import { inboxContacts, inboxMessages, inboxNotes, inboxTasks } from "@/lib/inbox/schema";
import { createNote, createTask } from "@/lib/inbox/notesAndTasks";
import { crmConversationMessages } from "@/lib/crm/schema";
import { MAILBOXES, REPLY_MIX, TEAM, type ReplyIntent } from "./content";
import { DAY, HOUR, MINUTE, count, replyText, type DemoContext, type DemoPerson } from "./context";

// ---------------------------------------------------------------------------
// Campaign definitions and sequence copy
// ---------------------------------------------------------------------------

type Region = "us" | "emea";

type CampaignDef = {
  key: string;
  name: string;
  status: CampaignStatus;
  region: Region;
  size: number;
  /** Days ago the campaign was launched, and the day its last first-touch went out. */
  startDays: number;
  lastFirstTouchDays: number;
  /** How many leads have had a first email (the rest are still waiting). */
  contacted: number;
  steps: SequenceStep[];
  mailboxes: number[];
  replyChance: number;
  /** Shape of first-touch volume over the campaign's life: above 1 front-loads, below 1 ramps up. */
  ramp: number;
  pausedDaysAgo?: number;
  score: (p: DemoPerson) => number;
};

const EMEA = new Set(["UK", "DE", "NL", "FR", "SE", "IE", "ES"]);
const industryScore = (weights: Record<string, number>) => (p: DemoPerson) => weights[p.company.industry] ?? 0;

const CAMPAIGNS: CampaignDef[] = [
  {
    key: "agency",
    ramp: 1,
    name: "Agency partners · intro",
    status: "draft",
    region: "us",
    size: 15,
    startDays: 0,
    lastFirstTouchDays: 0,
    contacted: 0,
    replyChance: 0,
    mailboxes: [],
    score: industryScore({ Agency: 3, Martech: 2, "B2B SaaS": 1 }),
    steps: [
      {
        stepNumber: 1,
        waitDays: 0,
        subject: "A referral idea for {{company}}",
        body: "Hi {{firstName}},\n\nYour clients are probably asking you about outbound at some point, and most agencies end up building a research process from scratch for each one.\n\nWe work with a small group of agencies and RevOps consultancies who use Northwind Signal to prioritise accounts for their clients, then keep the sequencer the client already has. In return they get a referral fee on every customer they introduce.\n\nWould a 20-minute call to see whether it fits how {{company}} works be useful?\n\n%signature%",
      },
      {
        stepNumber: 2,
        waitDays: 4,
        subject: "",
        body: "Hi {{firstName}},\n\nFollowing up on my note about a partnership. The short version: your team keeps working the way it does today, and clients get a clearer weekly list of who to contact and why.\n\nI can send a one-page overview of the partner terms if that is easier than a call.\n\n%signature%",
      },
    ],
  },
  {
    key: "healthtech",
    ramp: 1,
    name: "Healthtech ops · webinar follow-up",
    status: "completed",
    region: "us",
    size: 60,
    startDays: 80,
    lastFirstTouchDays: 59,
    contacted: 60,
    replyChance: 0.07,
    mailboxes: [1, 3, 5],
    score: industryScore({ Healthtech: 4, Insurtech: 3, Edtech: 2, "Legal tech": 2, Proptech: 1, "HR tech": 1 }),
    steps: [
      {
        stepNumber: 1,
        waitDays: 0,
        subject: "Following up on the sales and ops session, {{firstName}}",
        body: "Hi {{firstName}},\n\nThanks for registering for our session on getting sales and operations onto the same numbers. Several people asked afterwards how teams in regulated spaces handle their lead data, so here is the short answer: Northwind Signal is SOC 2 Type II and every customer's data sits in its own isolated workspace.\n\nIf it would help to see it with {{company}}'s accounts rather than a slide, I can set up a 20-minute walkthrough this week or next.\n\n%signature%",
      },
      {
        stepNumber: 2,
        waitDays: 4,
        subject: "",
        body: "Hi {{firstName}},\n\nOne more thing from the session. I put the slides and our two-page security summary into a single link. Reply with \"send\" and I will forward it, no call needed.\n\nIf a walkthrough is more useful, the offer stands.\n\n%signature%",
      },
    ],
  },
  {
    key: "closedlost",
    ramp: 1,
    name: "Closed-lost re-engagement",
    status: "paused",
    region: "us",
    size: 35,
    startDays: 34,
    lastFirstTouchDays: 11,
    contacted: 35,
    replyChance: 0.07,
    pausedDaysAgo: 9,
    mailboxes: [0, 2, 3],
    score: () => 0,
    steps: [
      {
        stepNumber: 1,
        waitDays: 0,
        subject: "A lot has changed since we last spoke",
        body: "Hi {{firstName}},\n\nWe talked a while back about Northwind Signal and the timing was not right for {{company}}. Since then we have added HubSpot and Salesforce sync and a shared team inbox, and Starter is now 49 USD per seat per month.\n\nWorth a fresh look? I can show you only what is new, in 15 minutes.\n\n%signature%",
      },
      {
        stepNumber: 2,
        waitDays: 6,
        subject: "",
        body: "Hi {{firstName}},\n\nIf budget was what stood in the way last time, we now run a free 14-day pilot: two seats, one campaign, nothing to sign. It is an easy way to see whether the numbers hold up on {{company}}'s own accounts.\n\nWant me to set it up?\n\n%signature%",
      },
    ],
  },
  {
    key: "emea",
    ramp: 0.85,
    name: "Series B founders · EMEA",
    status: "active",
    region: "emea",
    size: 80,
    startDays: 24,
    lastFirstTouchDays: 1.5,
    contacted: 74,
    replyChance: 0.075,
    mailboxes: [3, 4, 1],
    score: (p) => (EMEA.has(p.company.country) ? 3 : 0) + (p.seniority === "Founder" || p.seniority === "C-level" ? 1 : 0),
    steps: [
      {
        stepNumber: 1,
        waitDays: 0,
        subject: "Outbound without the research tax",
        body: "Hi {{firstName}},\n\nAt {{industry}} companies of {{company}}'s size, outbound usually still runs through the founders or one or two reps, and most of their hours go on deciding who to contact rather than talking to them.\n\nNorthwind Signal scores accounts against your ICP and drafts the first touch, so a small team can work 400 accounts a week properly. Customers see research time per account fall from about 25 minutes to under 5.\n\nWould a 15-minute call next week be useful?\n\n%signature%",
      },
      {
        stepNumber: 2,
        waitDays: 3,
        subject: "",
        body: "Hi {{firstName}},\n\nOne thing worth knowing if you are comparing tools: we do not replace the sequencer you already use. Northwind Signal decides who and why, then feeds the tool you have, so there is nothing to migrate.\n\nI can show a short walkthrough using {{company}} as the example, if that helps.\n\n%signature%",
      },
      {
        stepNumber: 3,
        waitDays: 6,
        subject: "Two seats, 14 days, free",
        body: "Hi {{firstName}},\n\nLast note from me. If you would rather try it than sit through a demo, we run a free pilot: two seats for 14 days on one campaign, no contract.\n\nThe median customer books 31% more first meetings in their first quarter. If {{company}} wants to find out whether that holds for you, reply and I will set it up this week.\n\n%signature%",
      },
    ],
  },
  {
    key: "revops",
    ramp: 1.5,
    name: "RevOps leaders · US mid-market",
    status: "active",
    region: "us",
    size: 110,
    startDays: 45,
    lastFirstTouchDays: 3.5,
    contacted: 104,
    replyChance: 0.085,
    mailboxes: [0, 1, 2, 5],
    score: (p) =>
      (["US", "CA", "AU"].includes(p.company.country) ? 3 : 0) +
      (/Revenue|Sales Op|Sales|SDR|Growth/i.test(p.title) ? 1 : 0),
    steps: [
      {
        stepNumber: 1,
        waitDays: 0,
        subject: "Monday pipeline review at {{company}}",
        body: "Hi {{firstName}},\n\nMost RevOps teams I talk to in {{industry}} spend part of every week stitching lead and account data together from three or four tools before reps can start prospecting.\n\nNorthwind Signal pulls that into one place, scores accounts against your ICP and tells each rep who to contact this week and why. Customers cut research time per account from about 25 minutes to under 5.\n\nOpen to a 20-minute look at how it would work on {{company}}'s accounts?\n\n%signature%",
      },
      {
        stepNumber: 2,
        waitDays: 3,
        subject: "",
        body: "Hi {{firstName}},\n\nQuick follow-up in case this got buried. One example: Brightloop, a 140-person B2B SaaS company, went from 38 to 81 first meetings a month inside a quarter, mostly because their six SDRs stopped researching accounts by hand.\n\nIf it is useful I can send the two-page summary of how they set it up.\n\n%signature%",
      },
      {
        stepNumber: 3,
        waitDays: 5,
        subject: "Should I close this out, {{firstName}}?",
        body: "Hi {{firstName}},\n\nI will stop here so I do not clutter your inbox. If prospect prioritisation is not on your list this quarter, no problem at all.\n\nIf it is, we run a free 14-day pilot: two seats, one campaign, no contract. I am happy to set one up for {{company}} whenever suits you.\n\nThanks for reading either way.\n\n%signature%",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function ids(ctx: DemoContext) {
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[ctx.rand.int(0, 15)]).join("");
  const alnum = (n: number) => Array.from({ length: n }, () => ALNUM[ctx.rand.int(0, ALNUM.length - 1)]).join("");
  return { hex, messageId: () => `<CA${alnum(40)}@mail.gmail.com>` };
}

/** A weekday working-hours moment on (or next to) `base`'s date. */
function slot(ctx: DemoContext, base: Date, region: Region, dir: 1 | -1): Date {
  const d = new Date(base);
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + (dir === 1 && ctx.rand.chance(0.6) ? 2 : -1));
  if (dow === 0) d.setUTCDate(d.getUTCDate() + (dir === 1 && ctx.rand.chance(0.7) ? 1 : -2));
  const [from, to] = region === "us" ? [13, 21] : [8, 16];
  d.setUTCHours(ctx.rand.int(from, to), ctx.rand.int(0, 59), ctx.rand.int(0, 59), 0);
  return d;
}

const minutes = (n: number) => n * MINUTE;

type SentStep = {
  n: number;
  t: Date;
  subject: string;
  body: string;
  gmailMessageId: string;
  messageId: string;
  threadId: string;
  inReplyTo: string | null;
  references: string[] | null;
  emailId?: string;
};

type Plan = {
  def: CampaignDef;
  person: DemoPerson;
  leadId: string;
  mailboxIdx: number;
  /** When each step is due, whether or not it has gone out. */
  due: Date[];
  sent: SentStep[];
  failed: { n: number; t: Date; error: string } | null;
  reply: { step: SentStep; intent: ReplyIntent; at: Date } | null;
  bounceAt: Date | null;
  unsubAt: Date | null;
  lastActivity: Date;
};

// ---------------------------------------------------------------------------

export async function seedEmail(ctx: DemoContext): Promise<void> {
  const org = currentOrganizationId();
  const { rand } = ctx;
  const gen = ids(ctx);

  // --- Mailboxes ----------------------------------------------------------
  const startOfToday = new Date(ctx.now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const zones: Record<string, string> = {
    alex: "America/New_York",
    priya: "America/New_York",
    jordan: "America/Chicago",
    sam: "Europe/London",
    lena: "Europe/Berlin",
  };
  const mailboxRows = await db
    .insert(mailboxes)
    .values(
      MAILBOXES.map((m, i) => {
        const created = new Date(ctx.now.getTime() - (104 - i * 3) * DAY + rand.int(8, 17) * HOUR);
        const team = TEAM[m.owner];
        return {
          organizationId: org,
          emailAddress: m.email,
          displayName: m.name,
          status: "connected" as const,
          lastTestedAt: new Date(ctx.now.getTime() - rand.int(2, 40) * HOUR),
          lastHistoryId: String(7_400_000 + rand.int(1000, 90_000)),
          dailySendLimit: m.dailyLimit,
          todayEmailsSent: 0,
          sendCounterResetAt: startOfToday,
          nextEmailTime: new Date(ctx.now.getTime() + rand.int(3, 25) * MINUTE),
          signatureHtml: `${team.name}\n${team.title}, Northwind`,
          // Always open: sending runs at any time. The zone is the day the mailbox's daily count resets on.
          workingHours: alwaysOpenHours(zones[m.owner]!),
          createdAt: created,
          updatedAt: created,
        };
      }),
    )
    .returning({ id: mailboxes.id, emailAddress: mailboxes.emailAddress });
  const mailboxIdByEmail = new Map(mailboxRows.map((r) => [r.emailAddress, r.id]));
  const mailboxId = (i: number) => mailboxIdByEmail.get(MAILBOXES[i].email)!;
  count(ctx, "email mailboxes", mailboxRows.length);

  // --- Campaigns and their leads -------------------------------------------
  const used = new Set<string>();
  const order = ["agency", "healthtech", "emea", "revops", "closedlost"];
  const peopleByCampaign = new Map<string, DemoPerson[]>();
  for (const key of order) {
    const def = CAMPAIGNS.find((c) => c.key === key)!;
    const candidates = rand.shuffle(ctx.pools.email.filter((p) => !used.has(p.id)));
    const picked = candidates
      .map((p, i) => ({ p, s: def.score(p), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, def.size)
      .map((x) => x.p);
    picked.forEach((p) => used.add(p.id));
    peopleByCampaign.set(key, rand.shuffle(picked));
  }

  const campaignId = new Map<string, string>();
  const leadIdByPerson = new Map<string, string>(); // personId -> outreach lead id (one campaign each)
  for (const def of CAMPAIGNS) {
    const created = await createCampaign({ name: def.name });
    campaignId.set(def.key, created.id);
    await updateCampaignSequence(created.id, def.steps);
    await addPeopleToEmailCampaign(created.id, peopleByCampaign.get(def.key)!.map((p) => p.id));
    if (def.status !== "draft") await setCampaignStatus(created.id, def.status);
  }
  const leadRows = await db
    .select({ id: outreachLeads.id, personId: outreachLeads.personId })
    .from(outreachLeads)
    .where(inArray(outreachLeads.campaignId, [...campaignId.values()]));
  for (const r of leadRows) leadIdByPerson.set(r.personId, r.id);
  count(ctx, "email campaigns", CAMPAIGNS.length);
  count(ctx, "email campaign leads", leadRows.length);

  // --- Plan every lead's journey ------------------------------------------
  const plans: Plan[] = [];
  for (const def of CAMPAIGNS) {
    if (def.status === "draft") continue;
    const people = peopleByCampaign.get(def.key)!;
    const pauseAt = def.pausedDaysAgo !== undefined ? slot(ctx, new Date(ctx.now.getTime() - def.pausedDaysAgo * DAY), def.region, -1) : null;
    const cutoff = pauseAt ?? new Date(ctx.now.getTime() - 10 * MINUTE);
    const rotate = rand.int(0, def.mailboxes.length - 1);
    people.forEach((person, j) => {
      const plan: Plan = {
        def,
        person,
        leadId: leadIdByPerson.get(person.id)!,
        mailboxIdx: def.mailboxes[(j + rotate) % def.mailboxes.length],
        due: [],
        sent: [],
        failed: null,
        reply: null,
        bounceAt: null,
        unsubAt: null,
        lastActivity: ctx.now,
      };
      plans.push(plan);
      if (j >= def.contacted) return; // still waiting for its first email

      // Due times: first touches ramp up over the campaign's life.
      const u = (j + rand.next()) / def.contacted;
      const f = Math.pow(u, def.ramp);
      const daysAgo = def.startDays - (def.startDays - def.lastFirstTouchDays) * f;
      let t = slot(ctx, new Date(ctx.now.getTime() - daysAgo * DAY), def.region, -1);
      while (t.getTime() > ctx.now.getTime() - 15 * MINUTE) t = slot(ctx, new Date(t.getTime() - DAY), def.region, -1);
      plan.due.push(t);
      for (let k = 1; k < def.steps.length; k++) {
        plan.due.push(slot(ctx, new Date(plan.due[k - 1].getTime() + (def.steps[k].waitDays + rand.int(0, 2)) * DAY), def.region, 1));
      }
      for (let k = 0; k < def.steps.length; k++) {
        if (plan.due[k].getTime() < cutoff.getTime()) plan.sent.push(renderStep(plan, k));
      }
    });
  }

  function renderStep(plan: Plan, k: number, ids?: boolean): SentStep {
    const { def, person } = plan;
    const step = def.steps[k];
    const vars = personVariables(
      { email: person.email, linkedinUrl: null, firstName: person.firstName, lastName: person.lastName, fullName: person.fullName, title: person.title, raw: {} },
      { domain: person.company.domain, name: person.company.name, linkedinUrl: null, raw: { industry: person.company.industry, employees: person.company.employees } },
    );
    const signature = `${TEAM[MAILBOXES[plan.mailboxIdx].owner].name}\n${TEAM[MAILBOXES[plan.mailboxIdx].owner].title}, Northwind`;
    const rendered = renderEmail(step, { email: person.email, variables: vars }, signature, { includeUnsubscribeFooter: false });
    let subject = rendered.subject;
    let threadId = gen.hex(16);
    let inReplyTo: string | null = null;
    let references: string[] | null = null;
    if (!subject.trim()) {
      // A step without its own subject threads under the last one that had a subject.
      const parent = [...plan.sent].reverse().find((s) => s.subject.trim() && !/^re:/i.test(s.subject)) ?? plan.sent[0];
      if (parent) {
        subject = /^re:\s/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
        threadId = parent.threadId;
        inReplyTo = plan.sent[plan.sent.length - 1].messageId;
        references = plan.sent.map((s) => s.messageId);
      } else {
        subject = `Re: ${fillSubject(def.steps[0].subject, vars)}`;
      }
    }
    void ids;
    return {
      n: step.stepNumber,
      t: plan.due[k],
      subject,
      body: rendered.body,
      gmailMessageId: gen.hex(16),
      messageId: gen.messageId(),
      threadId,
      inReplyTo,
      references,
    };
  }
  function fillSubject(s: string, vars: Record<string, string>) {
    return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? "");
  }

  // Bounces, replies, unsubscribes and failures decide where a journey stops.
  const contactedPlans = plans.filter((p) => p.sent.length > 0);
  // Targets, not independent coin flips: about 2% of contacted leads bounce and
  // about 9% reply, weighted towards the campaigns with the better reply rate.
  const bounceTarget = Math.round(contactedPlans.length * 0.02);
  const replyTarget = Math.round(contactedPlans.length * 0.09);
  for (const plan of rand.shuffle(contactedPlans).slice(0, bounceTarget)) {
    plan.sent = plan.sent.slice(0, 1);
    plan.bounceAt = new Date(plan.sent[0].t.getTime() + rand.int(1, 9) * MINUTE);
  }
  let replyCount = 0;
  const candidates = contactedPlans
    .filter((p) => !p.bounceAt && p.def.replyChance > 0)
    .map((p) => ({ p, key: Math.pow(rand.next(), 1 / p.def.replyChance) }))
    .sort((x, y) => y.key - x.key)
    .map((x) => x.p);
  for (const plan of candidates) {
    if (replyCount >= replyTarget) break;
    const upto = plan.sent.length;
    const weights = [0.55, 0.3, 0.15].slice(0, upto);
    const step = plan.sent[rand.weighted(weights.map((w, i) => [i, w] as const))];
    const gap = 20 + Math.floor(2860 * Math.pow(rand.next(), 2.2));
    let at = new Date(step.t.getTime() + gap * MINUTE);
    const hour = at.getUTCHours();
    if (hour < 7) at = new Date(at.getTime() + (7 - hour + rand.int(0, 2)) * HOUR);
    else if (hour >= 22) at = new Date(at.getTime() + (31 - hour) * HOUR);
    if (at.getTime() > ctx.now.getTime() - 2 * MINUTE || at.getTime() < step.t.getTime() + minutes(15)) continue;
    plan.sent = plan.sent.filter((s) => s.t.getTime() < at.getTime());
    plan.reply = { step, intent: "Other", at };
    replyCount += 1;
  }
  // Intents follow the reply mix exactly (largest remainder) rather than by independent draws,
  // so a small sample still looks like a healthy program.
  {
    const withReply = contactedPlans.filter((p) => p.reply);
    const total = REPLY_MIX.reduce((sum, [, w]) => sum + w, 0);
    const quotas = REPLY_MIX.map(([intent, w]) => ({ intent, exact: (withReply.length * w) / total }));
    const pool: ReplyIntent[] = quotas.flatMap((q) => Array<ReplyIntent>(Math.floor(q.exact)).fill(q.intent));
    const byRemainder = [...quotas].sort((a, b) => (b.exact % 1) - (a.exact % 1));
    for (const q of byRemainder) if (pool.length < withReply.length) pool.push(q.intent);
    const shuffled = rand.shuffle(pool);
    withReply.forEach((p, i) => (p.reply!.intent = shuffled[i]));
  }
  // Two people unsubscribe from the footer link without writing back.
  {
    const eligible = rand.shuffle(contactedPlans.filter((p) => !p.reply && !p.bounceAt && p.sent.length >= 2 && p.def.key !== "closedlost"));
    for (const plan of eligible.slice(0, 3)) {
      plan.unsubAt = new Date(plan.sent[plan.sent.length - 1].t.getTime() + rand.int(25, 600) * MINUTE);
      if (plan.unsubAt.getTime() > ctx.now.getTime() - 5 * MINUTE) plan.unsubAt = null;
    }
  }
  // A few recent follow-ups failed at Gmail (quota, a timeout).
  {
    const errors = [
      "Gmail API: User-rate limit exceeded. Retry after the next window (429)",
      "Gmail API: Daily user sending quota exceeded (429)",
      "Gmail API: Backend error, the service is temporarily unavailable (503)",
      "Request timed out while submitting the message to Gmail",
    ];
    const recent = rand.shuffle(
      contactedPlans.filter(
        (p) =>
          p.def.status === "active" && !p.reply && !p.bounceAt && !p.unsubAt && p.sent.length >= 2 && p.sent.length < p.def.steps.length &&
          p.sent[p.sent.length - 1].t.getTime() > ctx.now.getTime() - 3 * DAY,
      ),
    );
    for (const plan of recent.slice(0, 5)) {
      const last = plan.sent.pop()!;
      plan.failed = { n: last.n, t: last.t, error: rand.pick(errors) };
    }
  }

  // --- Persist sent, failed and scheduled emails; settle lead state --------
  type EmailInsert = typeof outreachEmails.$inferInsert;
  const emailRows: EmailInsert[] = [];
  type LeadState = { id: string; status: OutreachLeadStatus; step: number; next: Date | null; mailboxId: string | null; created: Date; updated: Date };
  const leadStates: LeadState[] = [];
  const horizon = new Date(ctx.now.getTime() + 36 * HOUR);

  for (const def of CAMPAIGNS) {
    if (def.status === "draft") continue;
    const campaignStart = new Date(ctx.now.getTime() - (def.startDays + 1) * DAY);
    for (const plan of plans.filter((p) => p.def === def)) {
      const s = plan.sent.length;
      const total = def.steps.length;
      const mbId = mailboxId(plan.mailboxIdx);
      for (const st of plan.sent) {
        emailRows.push({
          leadId: plan.leadId, mailboxId: mbId, stepNumber: st.n, subject: st.subject, body: st.body, status: "sent",
          sentAt: st.t, gmailMessageId: st.gmailMessageId, messageId: st.messageId, threadId: st.threadId,
          inReplyTo: st.inReplyTo, references: st.references, createdAt: new Date(st.t.getTime() - rand.int(1, 4) * MINUTE),
        });
      }
      if (plan.failed) {
        const f = plan.failed;
        const failedStep = renderStep(plan, f.n - 1);
        emailRows.push({
          leadId: plan.leadId, mailboxId: mbId, stepNumber: f.n, subject: failedStep.subject, body: failedStep.body, status: "failed",
          error: f.error, inReplyTo: failedStep.inReplyTo, references: failedStep.references, createdAt: f.t,
        });
      }
      const lastSent = plan.sent[s - 1]?.t ?? null;
      plan.lastActivity = [lastSent, plan.reply?.at, plan.bounceAt, plan.unsubAt, plan.failed?.t].filter((d): d is Date => !!d).reduce((a, b) => (a > b ? a : b), campaignStart);

      let status: OutreachLeadStatus = "pending";
      let next: Date | null = null;
      if (s > 0 || plan.failed) {
        status = s <= 1 ? "initial_sent" : "in_follow_up";
        if (s === 0) status = "pending";
      }
      const finished = !plan.reply && !plan.bounceAt && !plan.unsubAt && !plan.failed;
      if (s > 0 && s === total && finished) status = "sequence_completed";
      else if (s > 0 && finished && s < total) {
        let due = plan.due[s];
        if (def.status === "active" && due.getTime() < ctx.now.getTime() + 5 * MINUTE) due = new Date(ctx.now.getTime() + rand.int(20, 240) * MINUTE);
        next = due;
        if (def.status === "active" && due.getTime() < horizon.getTime()) {
          const sched = renderStep(plan, s);
          emailRows.push({
            leadId: plan.leadId, mailboxId: mbId, stepNumber: s + 1, subject: sched.subject, body: sched.body, status: "scheduled",
            inReplyTo: sched.inReplyTo, references: sched.references, createdAt: new Date(ctx.now.getTime() - rand.int(5, 180) * MINUTE),
          });
        }
      } else if (s === 0 && def.status === "active") {
        // Waiting for its first email: due over the next couple of days.
        const due = slot(ctx, new Date(ctx.now.getTime() + rand.int(4, 52) * HOUR), def.region, 1);
        next = due;
        if (due.getTime() < horizon.getTime()) {
          const sched = renderStep(plan, 0);
          emailRows.push({
            leadId: plan.leadId, mailboxId: mbId, stepNumber: 1, subject: sched.subject, body: sched.body, status: "scheduled",
            createdAt: new Date(ctx.now.getTime() - rand.int(5, 180) * MINUTE),
          });
        }
      }
      leadStates.push({
        id: plan.leadId, status, step: s, next, mailboxId: s > 0 || plan.failed ? mbId : null,
        created: new Date(campaignStart.getTime() + rand.int(1, 90) * MINUTE),
        updated: s > 0 || plan.failed ? plan.lastActivity : campaignStart,
      });
    }
  }
  // Draft campaign leads: pending, created when the sequence was written.
  for (const def of CAMPAIGNS.filter((c) => c.status === "draft")) {
    const created = new Date(ctx.now.getTime() - 2.2 * DAY);
    for (const person of peopleByCampaign.get(def.key)!) {
      leadStates.push({ id: leadIdByPerson.get(person.id)!, status: "pending", step: 0, next: null, mailboxId: null, created, updated: created });
    }
  }

  for (let i = 0; i < emailRows.length; i += 200) {
    const inserted = await db.insert(outreachEmails).values(emailRows.slice(i, i + 200)).returning({ id: outreachEmails.id, leadId: outreachEmails.leadId, stepNumber: outreachEmails.stepNumber });
    for (const row of inserted) {
      const plan = plans.find((p) => p.leadId === row.leadId);
      const st = plan?.sent.find((s) => s.n === row.stepNumber);
      if (st) st.emailId = row.id;
    }
  }
  const sentCount = emailRows.filter((r) => r.status === "sent").length;
  count(ctx, "email sent", sentCount);
  count(ctx, "email scheduled sends", emailRows.filter((r) => r.status === "scheduled").length);
  count(ctx, "email failed sends", emailRows.filter((r) => r.status === "failed").length);

  for (let i = 0; i < leadStates.length; i += 25) {
    await Promise.all(
      leadStates.slice(i, i + 25).map((l) =>
        db
          .update(outreachLeads)
          .set({ sequenceStatus: l.status, currentStep: l.step, nextSendAt: l.next, mailboxId: l.mailboxId, createdAt: l.created, updatedAt: l.updated })
          .where(eq(outreachLeads.id, l.id)),
      ),
    );
  }
  for (const def of CAMPAIGNS) {
    const mine = plans.filter((p) => p.def === def);
    const created = new Date(ctx.now.getTime() - (def.status === "draft" ? 2.3 : def.startDays + 1.2) * DAY);
    const lastSend = mine.flatMap((p) => p.sent.map((s) => s.t)).reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
    const updated =
      def.status === "active" ? new Date(ctx.now.getTime() - rand.int(20, 90) * MINUTE)
      : def.status === "paused" ? new Date(ctx.now.getTime() - (def.pausedDaysAgo ?? 9) * DAY)
      : def.status === "completed" ? new Date((lastSend ?? created).getTime() + HOUR)
      : created;
    await db.update(outreachCampaigns).set({ createdAt: created, updatedAt: updated }).where(eq(outreachCampaigns.id, campaignId.get(def.key)!));
  }

  // --- Bounces and unsubscribes --------------------------------------------
  const suppressionDates = new Map<string, Date>();
  for (const plan of plans) {
    if (plan.bounceAt) {
      const mb = MAILBOXES[plan.mailboxIdx].email;
      await suppressEmailOutreach(plan.person.email, "bounced", `Bounced from ${mb}`, "bounced");
      suppressionDates.set(plan.person.email, plan.bounceAt);
    }
    if (plan.unsubAt) {
      await suppressEmailOutreach(plan.person.email, "unsubscribed", "Used the unsubscribe link in a campaign email", "suppressed");
      suppressionDates.set(plan.person.email, plan.unsubAt);
    }
  }

  // --- Replies, through the same bridge Gmail uses --------------------------
  const replyPlans = plans.filter((p) => p.reply).sort((a, b) => a.reply!.at.getTime() - b.reply!.at.getTime());
  const replied: { plan: Plan; contactId: string; messageId: string; intent: ReplyIntent; at: Date }[] = [];
  for (const plan of replyPlans) {
    const { step, intent, at } = plan.reply!;
    const owner = MAILBOXES[plan.mailboxIdx];
    const mailbox = owner.email;
    const subject = /^re:\s/i.test(step.subject) ? step.subject : `Re: ${step.subject}`;
    const msg: InboundMessage = {
      gmailMessageId: gen.hex(16),
      threadId: step.threadId,
      fromEmail: plan.person.email,
      fromName: plan.person.fullName,
      toEmail: mailbox,
      to: [{ email: mailbox, name: owner.name }],
      cc: [],
      replyTo: [],
      ccEmails: [],
      subject,
      bodyText: replyText(ctx, intent, "long", plan.person, TEAM[owner.owner].first),
      messageId: gen.messageId(),
      inReplyTo: step.messageId,
      internalDate: at,
    };
    const result = await ingestGmailReply(mailbox, msg, createStepLogger());
    if (result.skipped || !result.leadId) continue;
    const recordId = result.leadId;

    const [contact] = await db
      .update(inboxContacts)
      .set({ company: plan.person.company.name, campaignId: campaignId.get(plan.def.key)!, createdAt: at, updatedAt: at, lastReplyAt: at })
      .where(and(inOrg(inboxContacts), eq(inboxContacts.email, plan.person.email)))
      .returning({ id: inboxContacts.id });
    const [msgRow] = await db
      .update(inboxMessages)
      .set({ createdAt: at })
      .where(and(eq(inboxMessages.contactId, contact.id), eq(inboxMessages.direction, "inbound")))
      .returning({ id: inboxMessages.id });
    const [conv] = await db
      .select({ id: crmConversationMessages.id, conversationId: crmConversationMessages.conversationId })
      .from(crmConversationMessages)
      .where(and(eq(crmConversationMessages.personId, plan.person.id), eq(crmConversationMessages.direction, "inbound"), eq(crmConversationMessages.channel, "email")))
      .limit(1);

    ctx.replies.push({
      recordId,
      personId: plan.person.id,
      conversationId: conv.conversationId,
      messageId: conv.id,
      channel: "email",
      intent,
      sentAt: at,
      rep: owner.owner,
    });
    replied.push({ plan, contactId: contact.id, messageId: msgRow.id, intent, at });

    if (intent === "Do Not Contact") {
      await suppressEmailOutreach(plan.person.email, "unsubscribed", "Asked to be removed in a reply", "suppressed");
      suppressionDates.set(plan.person.email, new Date(at.getTime() + rand.int(5, 90) * MINUTE));
    }
    // The thread the lead sees: every email we sent before they wrote back.
    await db.insert(inboxMessages).values(
      plan.sent.map((s) => ({
        contactId: contact.id,
        direction: "outbound" as const,
        providerMessageKey: `demo-out:${s.gmailMessageId}`,
        subject: s.subject,
        bodyText: s.body,
        fromEmail: mailbox,
        toEmail: plan.person.email,
        sentAt: s.t,
        raw: { from: [{ email: mailbox, name: owner.name }], to: [{ email: plan.person.email, name: plan.person.fullName }], cc: [], bcc: [] },
        createdAt: s.t,
      })),
    );
  }
  count(ctx, "email replies", replied.length);

  // Suppression rows and lead timestamps were stamped now by the helpers.
  for (const [email, at] of suppressionDates) {
    await db.update(suppressionList).set({ createdAt: at }).where(and(inOrg(suppressionList), eq(suppressionList.email, email)));
  }
  count(ctx, "email bounces", plans.filter((p) => p.bounceAt).length);
  count(ctx, "email unsubscribes", suppressionDates.size - plans.filter((p) => p.bounceAt).length);
  for (let i = 0; i < plans.length; i += 25) {
    await Promise.all(
      plans.slice(i, i + 25).map((p) => {
        const state = leadStates.find((l) => l.id === p.leadId)!;
        return db.update(outreachLeads).set({ updatedAt: state.updated }).where(eq(outreachLeads.id, p.leadId));
      }),
    );
  }

  // --- Inbox state: read, important, tasks and notes -------------------------
  const byRecent = [...replied].sort((a, b) => b.at.getTime() - a.at.getTime());
  const unread = new Set(byRecent.filter((r) => r.intent !== "Out of Office").slice(0, 5).map((r) => r.messageId));
  for (const r of replied) {
    if (unread.has(r.messageId)) continue;
    const openedAt = new Date(Math.min(r.at.getTime() + rand.int(4, 360) * MINUTE, ctx.now.getTime() - MINUTE));
    await db.update(inboxMessages).set({ openedAt }).where(eq(inboxMessages.id, r.messageId));
  }
  const positive = replied.filter((r) => ["Meeting Requested", "Demo Request", "Information Requested", "Trial Requested", "Case Study"].includes(r.intent));
  const importantPicks = rand.shuffle(positive).slice(0, 6);
  for (const r of importantPicks) await db.update(inboxMessages).set({ important: true }).where(eq(inboxMessages.id, r.messageId));

  // Eight different jobs, each with its own due date. The table has no due-date
  // column, so the date reads in the title the way a rep would write it.
  type TaskTemplate = { intents: ReplyIntent[]; due: string; done: boolean; make: (first: string, company: string) => { name: string; description: string } };
  const taskTemplates: TaskTemplate[] = [
    { intents: ["Information Requested"], due: "overdue", done: false, make: (first, company) => ({ name: `Send the SOC 2 report and DPA to ${first}`, description: `${first} said security review is the long pole at ${company}. Send both documents with the pricing sheet so the review starts now.` }) },
    { intents: ["Meeting Requested"], due: "due today", done: false, make: (first, company) => ({ name: `Book a follow-up call with ${first}`, description: `${first} asked for time. Offer two afternoon slots early next week and bring a short agenda for ${company}.` }) },
    { intents: ["Demo Request"], due: "due this week", done: false, make: (first, company) => ({ name: `Prep a demo for ${company}'s HubSpot setup`, description: `Show CRM sync and reply classification first. ${first} wants to see how drafts look before they go out.` }) },
    { intents: ["Information Requested", "Meeting Requested"], due: "due tomorrow", done: false, make: (first, company) => ({ name: `Send pricing for 12 seats to ${first}`, description: `Quote the Team plan at 129 USD per seat per month, annual at 15% off. Anything above that goes to Alex before it is sent to ${company}.` }) },
    { intents: ["Trial Requested", "Demo Request"], due: "due this week", done: false, make: (first, company) => ({ name: `Set up a two-seat pilot for ${company}`, description: `Connect one mailbox and one campaign for ${first}'s team. Fourteen days, no contract. Check in on day 5.` }) },
    { intents: ["Connected to Different POC", "Case Study"], due: "overdue", done: false, make: (first, company) => ({ name: `Loop in Maya from sales ops at ${company}`, description: `${first} suggested the right owner. Write to her with a two-line summary, and copy ${first} so the intro stays warm.` }) },
    { intents: ["Case Study", "Information Requested"], due: "", done: true, make: (first, company) => ({ name: `Send the Brightloop case study to ${first}`, description: `Pair it with one line on how ${company}'s team size compares to Brightloop's.` }) },
    { intents: ["Not Required Right Now", "Already Using a Tool — Not Required"], due: "", done: true, make: (first, company) => ({ name: `Add ${first} to the next-fiscal-year re-engagement list`, description: `Budget is frozen at ${company} until the new fiscal year. Re-open the thread then with the pilot offer.` }) },
  ];
  const takenContacts = new Set<string>();
  const pickFor = (t: TaskTemplate) => {
    const ok = (r: (typeof replied)[number]) => !takenContacts.has(r.contactId);
    const hit = rand.shuffle(replied.filter((r) => ok(r) && t.intents.includes(r.intent)))[0]
      ?? rand.shuffle(positive.filter(ok))[0]
      ?? rand.shuffle(replied.filter((r) => ok(r) && r.intent !== "Out of Office" && r.intent !== "Do Not Contact"))[0];
    if (hit) takenContacts.add(hit.contactId);
    return hit;
  };
  let taskCount = 0;
  for (const t of taskTemplates) {
    const r = pickFor(t);
    if (!r) continue;
    const { name, description } = t.make(r.plan.person.firstName, r.plan.person.company.name);
    const created = new Date(Math.min(r.at.getTime() + rand.int(30, 360) * MINUTE, ctx.now.getTime() - 5 * MINUTE));
    const task = await createTask({ leadId: r.contactId, name: t.due ? `${name} (${t.due})` : name, description });
    await db
      .update(inboxTasks)
      .set({ createdAt: created, updatedAt: t.done ? new Date(Math.min(created.getTime() + rand.int(3, 40) * HOUR, ctx.now.getTime() - MINUTE)) : created, isCompleted: t.done })
      .where(eq(inboxTasks.id, task.id));
    taskCount += 1;
  }
  count(ctx, "inbox tasks", taskCount);

  const noteTemplates: ((first: string, company: string) => { title: string; description: string })[] = [
    (first, company) => ({ title: `${first}: what matters at ${company}`, description: `Wants reply classification and CRM sync above everything else. Currently a spreadsheet plus a sequencer they are not happy with. Decision sits with ${first} and their CRO.` }),
    (first, company) => ({ title: `${company}: intro call recap`, description: `Spoke for 20 minutes. ${first} runs a team of eight and loses most of the week to account research. Next step: demo with their ops lead as soon as they have a free slot.` }),
    (_first, company) => ({ title: `Security questionnaire for ${company}`, description: "They need the SOC 2 Type II report and the DPA before procurement will talk. Standard review is about two weeks, so send both up front." }),
    (first, company) => ({ title: `${company} pricing: Team vs Scale`, description: `${first} compared Team and Scale. Asked about annual discount; stay inside 15% and route anything above to Alex.` }),
    (first, company) => ({ title: `${company}: contract renewal timing`, description: `${first} mentioned their current tool renews in the spring. Good reason to start the pilot now so the comparison is ready by then.` }),
    (first, company) => ({ title: `${company}: intro to their head of growth`, description: `${first} offered to introduce their head of growth. Waiting on the intro email before writing to her directly.` }),
  ];
  const notePeople = rand.shuffle(replied.filter((r) => r.intent !== "Out of Office" && r.intent !== "Do Not Contact" && r.intent !== "Left Company")).slice(0, 6);
  for (const [i, r] of notePeople.entries()) {
    const { title, description } = noteTemplates[i](r.plan.person.firstName, r.plan.person.company.name);
    const note = await createNote({ leadId: r.contactId, title, description });
    const created = new Date(Math.min(r.at.getTime() + rand.int(2, 70) * HOUR, ctx.now.getTime() - 20 * MINUTE));
    await db.update(inboxNotes).set({ createdAt: created, updatedAt: created }).where(eq(inboxNotes.id, note.id));
  }
  count(ctx, "inbox notes", notePeople.length);

  // --- Today's counters ------------------------------------------------------
  const today = await db.execute<{ mailbox_id: string; n: number }>(sql`
    SELECT e.mailbox_id, count(*)::int AS n
    FROM outreach_emails e
    JOIN outreach_mailboxes m ON m.id = e.mailbox_id
    WHERE m.organization_id = ${org} AND e.status = 'sent' AND e.sent_at >= ${startOfToday.toISOString()}::timestamptz
    GROUP BY e.mailbox_id`);
  for (const row of today) {
    await db.update(mailboxes).set({ todayEmailsSent: Number(row.n) }).where(eq(mailboxes.id, row.mailbox_id));
  }
}
