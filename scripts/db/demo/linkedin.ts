/**
 * Northwind's LinkedIn outbound: three connected accounts, three campaigns
 * with their leads walked through the invitation / acceptance / follow-up
 * sequence, the Messages inbox (a Connection + its Message rows), replies
 * handed to the CRM, a lived-in network of other connections, two completed
 * search batches, the platform job history and the webhook ledger.
 *
 * LinkedIn has no invitation or conversation tables, so a story is told with
 * the same rows the engine writes: Lead.requestSentAt + an INVITATION Message,
 * a Connection (chatId) once accepted, and ACCEPTANCE / FOLLOW_UP_n / RECEIVED /
 * CUSTOM_SENT Messages on it. Everything is inserted directly (the engine would
 * stamp "now" and call Unipile); replies reach the CRM through the same
 * `ingestInboundReply` the webhook uses, after the outbound rows exist, so its
 * outreach-history backfill copies the pitch into the conversation with the
 * right timestamps.
 */

import { createId } from "@paralleldrive/cuid2";
import { db } from "@/lib/db";
import { ingestInboundReply } from "@/lib/crm/conversations";
import {
  campaignAccounts,
  campaigns,
  connections,
  jobLogs,
  jobRuns,
  leads,
  linkedInAccounts,
  messages,
  searchBatches,
  searchQueries,
  searchResults,
  webhookEvents,
  type MessageType,
} from "@/lib/linkedin/schema";
import {
  FEMALE_FIRST,
  LAST_NAMES,
  MALE_FIRST,
  REPLY_MIX,
  TEAM,
  TITLES,
  type ReplyIntent,
  type TeamKey,
} from "./content";
import { DAY, HOUR, MINUTE, count, daysAgo, replyText, workTime, type DemoContext, type DemoPerson } from "./context";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type Rand = DemoContext["rand"];
const rid = (rand: Rand, n: number) => Array.from({ length: n }, () => B64URL[rand.int(0, B64URL.length - 1)]).join("");
const providerIdFor = (rand: Rand) => `ACoAA${rid(rand, 8)}${rid(rand, 26)}`;
const messageIdFor = (rand: Rand) => `2-${rid(rand, 42)}==`;
const chatIdFor = (rand: Rand) => rid(rand, 22);
const profileUrl = (slug: string) => `https://www.linkedin.com/in/${slug}`;
const ms = (t: Date) => t.getTime();
const plus = (t: Date, minutes: number) => new Date(ms(t) + minutes * MINUTE);

async function insertChunks<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/** Pushes a moment into the accounts' working window (Mon-Fri, 09:00-18:00 New York = 13:00-22:00 UTC). */
function inWindow(ctx: DemoContext, t: Date): Date {
  const d = new Date(t);
  const bump = () => {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(ctx.rand.int(13, 21), ctx.rand.int(0, 59), ctx.rand.int(0, 59), 0);
  };
  if (d.getUTCHours() >= 22) bump();
  else if (d.getUTCHours() < 13) d.setUTCHours(ctx.rand.int(13, 21), ctx.rand.int(0, 59), ctx.rand.int(0, 59), 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) bump();
  return d;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

type Sequence = {
  invitationMessage: string;
  acceptanceMessage: string;
  followUp1Message: string;
  followUp2Message: string;
  followUp3Message: string | null;
};

type CampaignPlan = {
  name: string;
  description: string;
  status: "ACTIVE" | "PAUSED";
  size: number;
  /** Days ago the first invitation went out, and the last (0 = still sending). */
  startDays: number;
  endDays: number;
  /** Share of the list not yet reached. */
  pendingShare: number;
  accounts: [TeamKey, TeamKey];
  sequence: Sequence;
};

const PLANS: CampaignPlan[] = [
  {
    name: "VP Sales · B2B SaaS 50–500",
    description: "Sales leaders at B2B SaaS companies between 50 and 500 people. Connect first, then one useful question about how they prioritise accounts.",
    status: "ACTIVE",
    size: 110,
    startDays: 45,
    endDays: 0,
    pendingShare: 0.15,
    accounts: ["alex", "priya"],
    sequence: {
      invitationMessage:
        "Hi {{firstName}}, I work with sales leaders at B2B SaaS companies like {{company}} and thought it would be useful to connect. Always keen to swap notes on what is working in outbound.",
      acceptanceMessage:
        "Thanks for connecting, {{firstName}}. Quick context on why I reached out: Northwind Signal helps sales teams see which accounts to work each week and why, so reps spend less time researching. How are you deciding who to prioritise at {{company}} right now?",
      followUp1Message:
        "No pitch, {{firstName}}. I am just curious how much time your reps spend researching an account before they reach out. Most VPs I speak with say 20+ minutes.",
      followUp2Message:
        "Happy to share a one-pager on how teams like {{company}} cut research to under 5 minutes per account and booked about 30% more first meetings. Want me to send it over?",
      followUp3Message:
        "Last note from me, {{firstName}}. If account prioritisation is not on your plate this quarter, no worries at all. If it is, I am glad to do a 20-minute walkthrough. Either way, good luck with the quarter.",
    },
  },
  {
    name: "Founders hiring their first SDRs",
    description: "Founders and heads of growth at seed to Series B companies about to build their first outbound team.",
    status: "ACTIVE",
    size: 80,
    startDays: 28,
    endDays: 0,
    pendingShare: 0.16,
    accounts: ["priya", "sam"],
    sequence: {
      invitationMessage:
        "Hi {{firstName}}, I follow what {{company}} is building. I talk with a lot of founders about setting up their first outbound motion and would enjoy having you in my network.",
      acceptanceMessage:
        "Thanks for connecting, {{firstName}}. Most founders I talk to run outbound themselves before the first SDR hire. We built Northwind Signal so that first hire (or you) starts with a ranked list instead of a blank spreadsheet. Are you planning to hire SDRs this year?",
      followUp1Message:
        "{{firstName}}, one thing that surprises founders: the first SDR usually spends their first month just figuring out who to contact. We have a short playbook on skipping that. Useful to you?",
      followUp2Message:
        "If it helps, I can share how two companies around your size set up their first sequence across LinkedIn and email: what they sent, who they targeted, what replied.",
      followUp3Message:
        "I will leave it here, {{firstName}}. If hiring SDRs moves up the list, I am happy to help you plan it. Congrats on the progress at {{company}}.",
    },
  },
  {
    name: "RevOps Summit follow-up",
    description: "People we met or were introduced to at RevOps Summit. Paused after the event window closed.",
    status: "PAUSED",
    size: 60,
    startDays: 70,
    endDays: 47,
    pendingShare: 0.12,
    accounts: ["alex", "sam"],
    sequence: {
      invitationMessage:
        "Hi {{firstName}}, we were both at RevOps Summit. It was good to see so many people asking hard questions about pipeline data. Would be glad to stay in touch.",
      acceptanceMessage:
        "Thanks for connecting, {{firstName}}. I promised a few people the slides from our session on account scoring. Happy to send them over if they would be useful for the team at {{company}}.",
      followUp1Message:
        "Here is what the session covered: how three teams re-scored their ICP in a week and what changed in who they contacted. Want the slides, {{firstName}}?",
      followUp2Message:
        "No rush on this. If scoring accounts is on the roadmap for {{company}}, I am happy to do a 15-minute walk through the approach.",
      followUp3Message: null,
    },
  },
];

/** Reps reword follow-ups a little per lead; the campaign keeps the main version. */
const ALTS: string[][][] = [
  [
    [
      "{{firstName}}, a quick one: how much of your reps' week goes on researching accounts rather than talking to them? Most sales leaders tell me more than they would like.",
      "Curious how {{company}} decides which accounts get worked first. Is that mostly rep judgement or something more systematic?",
    ],
    [
      "Teams like {{company}} usually cut account research to a few minutes with Signal. I can send a short summary of how, if useful.",
      "We have a one-pager on how a 40-rep team went from about 25 minutes of research per account to under 5. Happy to share it, {{firstName}}.",
    ],
    [
      "Closing the loop, {{firstName}}. If prioritising accounts is not a focus right now, completely understood. I am around if that changes.",
      "I will stop here so I do not clutter your inbox. If a short walkthrough ever helps, just say the word.",
    ],
  ],
  [
    [
      "{{firstName}}, most founders I speak to say the first SDR hire is the hardest one to get right. Is that on your radar at {{company}}?",
      "One thing worth knowing before the first SDR hire: the list and the first sequence matter more than the person. Happy to share what has worked.",
    ],
    [
      "I can send how a couple of seed-stage teams set up their first LinkedIn and email sequence, including what they sent. Useful?",
      "Happy to share a simple first-sequence template we see working for early teams. Want it, {{firstName}}?",
    ],
    [
      "Leaving it here for now, {{firstName}}. If you start hiring SDRs, I would be glad to help. All the best with {{company}}.",
      "Last message from me. If outbound is not the priority this quarter, no problem. Rooting for {{company}} either way.",
    ],
  ],
  [
    [
      "{{firstName}}, I can send the account-scoring slides from the Summit session if they would be useful. Takes two minutes to skim.",
      "Following up on the Summit: the session covered how three teams re-scored their ICP in a week. Want the slides?",
    ],
    [
      "If account scoring is on {{company}}'s roadmap, I would be happy to walk through how those teams did it in 15 minutes.",
      "No pressure, {{firstName}}. If it would help to compare notes on scoring, I am glad to find a time.",
    ],
    [],
  ],
];

function pickVariant(rand: Rand, main: string | null, alts: string[] | undefined): string | null {
  if (main === null) return null;
  const options = [main, main, ...(alts ?? [])];
  return options[rand.int(0, options.length - 1)];
}

/** The paused campaign stopped sending this many days ago. */
const PAUSED_DAYS_AGO = 40;

const render = (template: string | null, p: DemoPerson): string | null =>
  template === null
    ? null
    : template
        .replaceAll("{{firstName}}", p.firstName)
        .replaceAll("{{lastName}}", p.lastName)
        .replaceAll("{{fullName}}", p.fullName)
        .replaceAll("{{company}}", p.company.name)
        .replaceAll("{{title}}", p.title);

const repResponses: Record<string, string[]> = {
  "Meeting Requested": [
    "Brilliant, {lead}. I am free tomorrow afternoon or Friday morning. Which one is easier?",
    "Great, thanks {lead}. Does Thursday at 2pm ET work? I will send an invite as soon as you confirm.",
    "Perfect, I will send a calendar invite. Would Tuesday 10:30 or Wednesday 3pm suit you better?",
    "Appreciate it, {lead}. I will put two slots in your inbox this afternoon. Let me know if next week is too soon.",
  ],
  "Demo Request": [
    "Great to hear, {lead}. I will walk you through it live and use your own sequence as the example. Does Thursday morning work?",
    "Happy to. I can do a live walkthrough this week. Would 25 minutes on Wednesday afternoon work, or is Thursday better?",
    "Of course. I will show you the LinkedIn and email sequences side by side. Any day you prefer this week?",
  ],
  "Trial Requested": [
    "A pilot makes sense, {lead}. I will email you a short setup list so the first campaign is live by next week.",
    "Love that approach. We can set up a two-week pilot on one campaign. I will send over what we would need to get started.",
    "Yes, we can do that. Pilot on one account, one sequence, and we review the numbers after two weeks. Sound fair?",
  ],
  "Information Requested": [
    "Thanks {lead}. Sending pricing and the {company} integration notes to your inbox in a few minutes.",
    "Sure. Short version: Signal connects to HubSpot and Salesforce in about 20 minutes and most teams are live in their first week. Can I email you the one-pager and pricing?",
    "Of course, {lead}. I will send an overview and pricing to your email today. Anything specific you want covered, like security or CRM sync?",
  ],
  "Case Study": [
    "We have one from a team at a similar stage to {company}. I will send it with the numbers so you can judge for yourself.",
    "Yes. We have a write-up from a 40-rep SaaS team that cut research time from about 25 minutes to under 5 per account. I will send it over now.",
    "Good question. I will send you two examples, one in your industry. Happy to intro you to the customer if useful.",
  ],
};

const leadFollowUps: Record<string, string[]> = {
  "Meeting Requested": ["Thursday works, send the invite.", "Tuesday 10:30 is good. Thanks.", "Wednesday works. I will loop in our ops lead.", "Works for me. Use the email on my profile."],
  "Demo Request": ["Wednesday afternoon is good.", "Thursday works better for us. Around 3pm?", "Wednesday 2pm ET, please. Two of us will join."],
  "Trial Requested": ["Sounds good. Who do I send the account details to?", "Fair. Send over the setup checklist."],
  "Information Requested": ["Yes please, that would be great.", "That helps, thanks. Send it over.", "Please do. Include security if you have it."],
  "Case Study": ["Thanks, will take a look.", "Yes please. Sooner the better, we are deciding this month."],
};

const repFinals: Record<string, string[]> = {
  "Meeting Requested": ["Done, the invite is in your inbox. Talk then!", "Booked. You will get a calendar invite in a minute."],
  "Demo Request": ["Booked. I will send the invite and a short agenda.", "Done. Invite is on its way."],
  "Trial Requested": ["Great, I will send the setup checklist today."],
  "Information Requested": ["Sent. Shout if you want to walk through it together.", "Just emailed it over. Happy to answer anything once you have had a look."],
  "Case Study": ["Sent. Let me know what you think."],
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

type AccountRow = {
  key: TeamKey;
  id: string;
  linkedinId: string;
  username: string;
  premium: boolean;
};

type Stage = { type: MessageType; text: string; at: Date };

type MsgRow = typeof messages.$inferInsert;

type Replier = {
  accountLinkedinId: string;
  accountUsername: string;
  rep: TeamKey;
  person: DemoPerson;
  providerId: string;
  chatId: string;
  headline: string;
  intent: ReplyIntent;
  inbound: { text: string; at: Date; lmid: string }[];
};

type SendEvent = { at: Date; accountKey: TeamKey; kind: "invite" | "fu1" | "fu2" | "fu3"; url: string; providerId: string; complete: boolean };

type LedgerEntry = {
  kind: "accepted" | "reply" | "echo";
  at: Date;
  accountLinkedinId: string;
  accountUsername: string;
  providerId: string;
  name: string;
  headline: string;
  slug: string;
  pictureUrl: string | null;
  chatId: string;
  connectionId: string;
  text?: string;
  lmid?: string;
  leadStatus?: string;
  hasLead: boolean;
};

export async function seedLinkedin(ctx: DemoContext): Promise<void> {
  const { rand, now } = ctx;
  const org = ctx.organizationId;
  const nowCap = new Date(ms(now) - 5 * MINUTE);

  // -------------------------------------------------------------------- accounts
  const accountPlan: { key: TeamKey; username: string; premium: boolean; daysAgo: number; location: string; connections: number; searchToday: number }[] = [
    { key: "alex", username: "alexmorgan", premium: true, daysAgo: 92, location: "New York, NY", connections: 3180, searchToday: 41 },
    { key: "priya", username: "priyaraman-sales", premium: true, daysAgo: 80, location: "Austin, TX", connections: 2460, searchToday: 18 },
    { key: "sam", username: "samokafor", premium: false, daysAgo: 72, location: "Chicago, IL", connections: 910, searchToday: 0 },
  ];
  const accounts: AccountRow[] = [];
  for (const a of accountPlan) {
    const t = TEAM[a.key];
    const id = createId();
    const linkedinId = `nwd${rid(rand, 19)}`;
    const createdAt = daysAgo(ctx, a.daysAgo);
    await db.insert(linkedInAccounts).values({
      organizationId: org,
      id,
      linkedinId,
      username: a.username,
      name: t.name,
      profilePictureUrl: t.avatar,
      headline: `${t.title} at Northwind`,
      profileData: { provider: "LINKEDIN", location: a.location, connections_count: a.connections, premium: a.premium },
      status: "CONNECTED",
      limitReached: false,
      searchLeadsToday: a.searchToday,
      isPremium: a.premium,
      nextAllowedRun: plus(now, rand.int(6, 24)),
      createdAt,
      updatedAt: plus(now, -rand.int(3, 25)),
    });
    accounts.push({ key: a.key, id, linkedinId, username: a.username, premium: a.premium });
  }
  count(ctx, "LinkedIn accounts", accounts.length);
  const accountByKey = new Map(accounts.map((a) => [a.key, a]));

  // ---------------------------------------------------------------- campaigns
  const pool = rand.shuffle(ctx.pools.linkedin);
  const poolTotal = PLANS.reduce((s, p) => s + p.size, 0);
  const slices: DemoPerson[][] = [];
  {
    let offset = 0;
    for (const [i, plan] of PLANS.entries()) {
      // The last campaign takes whatever is left of the pool, so nobody is unused.
      const size = i === PLANS.length - 1 ? Math.max(plan.size, pool.length - offset) : plan.size;
      slices.push(pool.slice(offset, offset + size));
      offset += size;
    }
  }
  void poolTotal;

  const leadRows: (typeof leads.$inferInsert)[] = [];
  const connectionRows: (typeof connections.$inferInsert)[] = [];
  const messageRows: MsgRow[] = [];
  const repliers: Replier[] = [];
  const sendEvents: SendEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const campaignIds: string[] = [];

  for (const [ci, plan] of PLANS.entries()) {
    const campaignId = createId();
    campaignIds.push(campaignId);
    const people = slices[ci];
    const paused = plan.status === "PAUSED";
    const outCap = paused ? daysAgo(ctx, PAUSED_DAYS_AGO) : nowCap;
    const created = workTime(ctx, plan.startDays + 1);
    const seq = plan.sequence;
    const hasFu3 = seq.followUp3Message !== null;
    await db.insert(campaigns).values({
      organizationId: org,
      id: campaignId,
      name: plan.name,
      description: plan.description,
      status: plan.status,
      type: "REGULAR",
      invitationMessage: seq.invitationMessage,
      acceptanceMessage: seq.acceptanceMessage,
      followUp1Message: seq.followUp1Message,
      followUp2Message: seq.followUp2Message,
      followUp3Message: seq.followUp3Message,
      createdAt: created,
      updatedAt: paused ? outCap : plus(now, -rand.int(20, 600)),
    });
    const campAccounts = plan.accounts.map((k) => accountByKey.get(k)!);
    await db.insert(campaignAccounts).values(campAccounts.map((a) => ({ campaignId, linkedinAccountId: a.id })));

    const pendingN = Math.round(people.length * plan.pendingShare);
    const processed = people.slice(0, people.length - pendingN);
    const kinds = processed.map(() => {
      const r = rand.next();
      return r < 0.03 ? "failed" : r < 0.05 ? "cancelled" : "sent";
    });
    const sentN = kinds.filter((k) => k === "sent").length;

    // Business days the campaign was sending, and where each invitation falls:
    // gently denser later, like a team ramping up.
    const days: number[] = [];
    for (let d = plan.startDays; d >= plan.endDays; d--) {
      const dow = daysAgo(ctx, d).getUTCDay();
      if (dow !== 0 && dow !== 6) days.push(d);
    }
    const inviteTimes: Date[] = [];
    for (let k = 0; k < sentN; k++) {
      const idx = Math.min(days.length - 1, Math.floor(days.length * Math.pow(k / sentN, 0.85)));
      const t = daysAgo(ctx, days[idx]);
      t.setUTCHours(rand.int(13, 21), rand.int(0, 59), rand.int(0, 59), 0);
      // Never in the future or before the reps' working day has started: roll back to the previous weekday.
      while (ms(t) > ms(nowCap) - 10 * MINUTE || t.getUTCDay() === 0 || t.getUTCDay() === 6) {
        t.setUTCDate(t.getUTCDate() - 1);
        t.setUTCHours(rand.int(13, 21), rand.int(0, 59), rand.int(0, 59), 0);
      }
      inviteTimes.push(t);
    }
    inviteTimes.sort((a, b) => ms(a) - ms(b));

    let sentIdx = 0;
    for (const [pi, person] of people.entries()) {
      const leadId = createId();
      const providerId = providerIdFor(rand);
      const headline = `${person.title} at ${person.company.name}`;
      const base = {
        organizationId: org,
        id: leadId,
        personId: person.id,
        providerId,
        name: person.fullName,
        profilePictureUrl: person.avatarUrl,
        headline,
        location: person.location,
        campaignId,
        invitationMessage: render(seq.invitationMessage, person),
        acceptanceMessage: render(seq.acceptanceMessage, person),
        followUp1Message: render(pickVariant(rand, seq.followUp1Message, ALTS[ci]?.[0]), person),
        followUp2Message: render(pickVariant(rand, seq.followUp2Message, ALTS[ci]?.[1]), person),
        followUp3Message: render(pickVariant(rand, seq.followUp3Message, ALTS[ci]?.[2]), person),
        createdAt: created,
      };
      const account = campAccounts[(pi + ci) % 2];
      const kind = pi < processed.length ? kinds[pi] : "pending";

      if (kind === "pending") {
        leadRows.push({ ...base, status: "PENDING", updatedAt: created });
        continue;
      }
      if (kind === "failed" || kind === "cancelled") {
        const t = new Date(ms(created) + rand.int(1, Math.max(2, (plan.startDays - plan.endDays) * 12)) * HOUR);
        leadRows.push({
          ...base,
          status: kind === "failed" ? "FAILED" : "CANCELLED",
          inviteRetryCount: kind === "failed" ? 3 : 0,
          linkedinAccountId: kind === "failed" ? account.id : null,
          updatedAt: new Date(Math.min(ms(t), ms(nowCap))),
        });
        continue;
      }

      // ---- a sent invitation
      const invitedAt = inviteTimes[sentIdx++];
      const stages: Stage[] = [];
      let acceptedAt: Date | null = null;
      if (rand.chance(0.47)) {
        const delayDays = rand.weighted<[number, number]>([
          [[0.1, 1], 35],
          [[1, 3], 30],
          [[3, 7], 22],
          [[7, 14], 13],
        ]);
        const raw = new Date(ms(invitedAt) + rand.int(Math.round(delayDays[0] * 24 * 60), Math.round(delayDays[1] * 24 * 60)) * MINUTE);
        // People accept on weekends and evenings too, just less often.
        const candidate = inWindow(ctx, raw);
        if (ms(candidate) <= ms(outCap) - 40 * MINUTE) acceptedAt = candidate;
      }

      const texts: { type: MessageType; text: string }[] = [{ type: "ACCEPTANCE", text: base.acceptanceMessage! }];
      texts.push({ type: "FOLLOW_UP_1", text: base.followUp1Message! }, { type: "FOLLOW_UP_2", text: base.followUp2Message! });
      if (hasFu3) texts.push({ type: "FOLLOW_UP_3", text: base.followUp3Message! });
      const gaps = [0, 24, 48, 72];
      if (acceptedAt) {
        let at = plus(acceptedAt, rand.int(2, 25));
        for (const [si, s] of texts.entries()) {
          if (si > 0) at = inWindow(ctx, plus(at, gaps[si] * 60 + rand.int(0, 600)));
          if (ms(at) > ms(outCap)) break;
          stages.push({ ...s, at });
        }
      }

      // ---- a reply?
      let replyIntent: ReplyIntent | null = null;
      let replyAt: Date | null = null;
      if (acceptedAt && stages.length && rand.chance(ms(now) - ms(acceptedAt) < 6 * DAY ? 0.5 : 0.25)) {
        const weights = [45, 25, 18, 12].slice(0, stages.length);
        const s = rand.weighted(weights.map((w, i) => [i, w] as const));
        const within = rand.weighted<[number, number]>([[[20, 180], 50], [[180, 1500], 35], [[1500, 3000], 15]]);
        const at = plus(stages[s].at, rand.int(within[0], within[1]));
        const next = stages[s + 1]?.at;
        if (ms(at) <= ms(nowCap) && (!next || ms(at) < ms(next) - 15 * MINUTE)) {
          replyAt = at;
          replyIntent = rand.weighted(REPLY_MIX);
          stages.length = s + 1;
        }
      }

      // ---- rows
      const connectionId = acceptedAt ? createId() : null;
      const chatId = acceptedAt ? chatIdFor(rand) : null;
      const lastStage = stages[stages.length - 1];
      const followUps: Record<string, Date | undefined> = {
        FOLLOW_UP_1: stages.find((s) => s.type === "FOLLOW_UP_1")?.at,
        FOLLOW_UP_2: stages.find((s) => s.type === "FOLLOW_UP_2")?.at,
        FOLLOW_UP_3: stages.find((s) => s.type === "FOLLOW_UP_3")?.at,
      };
      const lastIdx = stages.length - 1;
      const exhausted = !replyAt && lastIdx === texts.length - 1;
      const statusAfterStage = ["ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT"] as const;
      const status = replyAt
        ? "REPLIED"
        : !acceptedAt
          ? "REQUEST_SENT"
          : exhausted
            ? "COMPLETED"
            : statusAfterStage[lastIdx];

      let lastActivity: Date = lastStage?.at ?? invitedAt;
      messageRows.push({
        organizationId: org,
        type: "INVITATION",
        text: base.invitationMessage!,
        connectionId,
        leadId,
        seen: true,
        createdAt: invitedAt,
      });
      sendEvents.push({ at: invitedAt, accountKey: account.key, kind: "invite", url: profileUrl(person.linkedinSlug), providerId, complete: false });
      for (const [si, s] of stages.entries()) {
        messageRows.push({
          organizationId: org,
          type: s.type,
          text: s.text,
          linkedinMessageId: messageIdFor(rand),
          connectionId,
          leadId,
          seen: true,
          createdAt: s.at,
        });
        if (si > 0) {
          const k = (["fu1", "fu2", "fu3"] as const)[si - 1];
          sendEvents.push({ at: s.at, accountKey: account.key, kind: k, url: profileUrl(person.linkedinSlug), providerId, complete: si === texts.length - 1 });
        }
      }

      if (acceptedAt && connectionId && chatId) {
        ledger.push({
          kind: "accepted",
          at: acceptedAt,
          accountLinkedinId: account.linkedinId,
          accountUsername: account.username,
          providerId,
          name: person.fullName,
          headline,
          slug: person.linkedinSlug,
          pictureUrl: person.avatarUrl,
          chatId,
          connectionId,
          hasLead: true,
          leadStatus: "REQUEST_SENT",
        });
      }

      if (replyAt && replyIntent && connectionId && chatId) {
        const rep = account.key;
        const repFirst = TEAM[rep].first;
        const inbound: Replier["inbound"] = [];
        const first = replyText(ctx, replyIntent, "short", person, repFirst);
        inbound.push({ text: first, at: replyAt, lmid: messageIdFor(rand) });
        const prevStatus = status === "REPLIED" ? statusAfterStage[Math.max(0, lastIdx)] : status;
        ledger.push({
          kind: "reply",
          at: replyAt,
          accountLinkedinId: account.linkedinId,
          accountUsername: account.username,
          providerId,
          name: person.fullName,
          headline,
          slug: person.linkedinSlug,
          pictureUrl: person.avatarUrl,
          chatId,
          connectionId,
          text: first,
          lmid: inbound[0].lmid,
          leadStatus: prevStatus,
          hasLead: true,
        });
        let cursor = replyAt;
        const sentRows: { text: string; at: Date; lmid: string; type: MessageType }[] = [];
        const talks = repResponses[replyIntent];
        if (talks && rand.chance(0.58)) {
          const repAt = inWindow(ctx, plus(cursor, rand.int(8, 300)));
          if (ms(repAt) <= ms(nowCap)) {
            sentRows.push({ text: rand.pick(talks).replaceAll("{lead}", person.firstName).replaceAll("{company}", person.company.name), at: repAt, lmid: messageIdFor(rand), type: "CUSTOM_SENT" });
            cursor = repAt;
            if (rand.chance(0.65)) {
              const at2 = plus(cursor, rand.int(5, 720));
              if (ms(at2) <= ms(nowCap)) {
                const t2 = rand.pick(leadFollowUps[replyIntent]);
                inbound.push({ text: t2, at: at2, lmid: messageIdFor(rand) });
                ledger.push({
                  kind: "reply",
                  at: at2,
                  accountLinkedinId: account.linkedinId,
                  accountUsername: account.username,
                  providerId,
                  name: person.fullName,
                  headline,
                  slug: person.linkedinSlug,
                  pictureUrl: person.avatarUrl,
                  chatId,
                  connectionId,
                  text: t2,
                  lmid: inbound[1].lmid,
                  leadStatus: "REPLIED",
                  hasLead: true,
                });
                cursor = at2;
                if (rand.chance(0.4)) {
                  const at3 = inWindow(ctx, plus(cursor, rand.int(6, 240)));
                  if (ms(at3) <= ms(nowCap)) {
                    sentRows.push({ text: rand.pick(repFinals[replyIntent]), at: at3, lmid: messageIdFor(rand), type: "CUSTOM_SENT" });
                    cursor = at3;
                  }
                }
              }
            }
          }
        }
        for (const s of sentRows) {
          messageRows.push({ organizationId: org, type: s.type, text: s.text, linkedinMessageId: s.lmid, connectionId, leadId, seen: true, createdAt: s.at });
          ledger.push({
            kind: "echo",
            at: plus(s.at, rand.int(0, 1)),
            accountLinkedinId: account.linkedinId,
            accountUsername: account.username,
            providerId,
            name: person.fullName,
            headline,
            slug: person.linkedinSlug,
            pictureUrl: person.avatarUrl,
            chatId,
            connectionId,
            text: s.text,
            lmid: s.lmid,
            leadStatus: "REPLIED",
            hasLead: true,
          });
        }
        const lastMessageIsInbound = inbound[inbound.length - 1].at.getTime() >= cursor.getTime();
        for (const [ii, m] of inbound.entries()) {
          const isLast = ii === inbound.length - 1;
          const unseen = isLast && lastMessageIsInbound && (ms(now) - ms(m.at) < 3.5 * DAY || rand.chance(0.08));
          messageRows.push({
            organizationId: org,
            type: "RECEIVED",
            text: m.text,
            linkedinMessageId: m.lmid,
            connectionId,
            leadId,
            seen: !unseen,
            createdAt: m.at,
          });
        }
        lastActivity = cursor;
        repliers.push({
          accountLinkedinId: account.linkedinId,
          accountUsername: account.username,
          rep,
          person,
          providerId,
          chatId,
          headline,
          intent: replyIntent,
          inbound,
        });
      }

      if (acceptedAt && connectionId && chatId) {
        connectionRows.push({
          organizationId: org,
          id: connectionId,
          providerId,
          name: person.fullName,
          headline,
          profilePictureUrl: person.avatarUrl,
          linkedinUrl: profileUrl(person.linkedinSlug),
          chatId,
          leadId,
          linkedinAccountId: account.id,
          connectedAt: acceptedAt,
          createdAt: acceptedAt,
          updatedAt: lastActivity,
        });
      }

      leadRows.push({
        ...base,
        status,
        linkedinAccountId: account.id,
        requestSentAt: invitedAt,
        acceptMessageSentAt: stages[0]?.at ?? null,
        followUp1SentAt: followUps.FOLLOW_UP_1 ?? null,
        followUp2SentAt: followUps.FOLLOW_UP_2 ?? null,
        followUp3SentAt: followUps.FOLLOW_UP_3 ?? null,
        updatedAt: lastActivity,
      });
    }
  }

  // ------------------------------------------------------- extra connections
  // The rest of the network: people who accepted a personal invitation or
  // connected first, none of them in a campaign.
  const networkPeople: { name: string; headline: string; slug: string; company: string }[] = ctx.pools.unassigned.map((p) => ({
    name: p.fullName,
    headline: `${p.title} at ${p.company.name}`,
    slug: p.linkedinSlug,
    company: p.company.name,
  }));
  while (networkPeople.length < 42) {
    const female = rand.chance(0.5);
    const first = rand.pick(female ? FEMALE_FIRST : MALE_FIRST);
    const last = rand.pick(LAST_NAMES);
    const company = rand.pick(ctx.companies);
    const title = rand.weighted(TITLES.map((t) => [t, t.weight] as const));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    networkPeople.push({
      name: `${first} ${last}`,
      headline: `${title.title} at ${company.name}`,
      slug: `${norm(first)}-${norm(last)}-${rid(rand, 5).toLowerCase().replace(/[-_]/g, "x")}`,
      company: company.name,
    });
  }
  const networkMessageTexts: [string, string][] = [
    ["Thanks for connecting. Saw your note about outbound, would be good to compare notes sometime.", "Likewise, {lead}. Happy to jump on a quick call whenever suits you."],
    ["Appreciate the add! We are rebuilding our SDR team at the moment, so the timing is funny.", "Good luck with it. If it helps, I can share how we structure the first 30 days."],
    ["Hey, thanks for connecting. Are you the one who spoke at the pipeline webinar last month?", "That was me. Glad it was useful, {lead}!"],
    ["Good to connect. Let me know if you ever want an intro to our RevOps lead.", "Will do, thank you {lead}."],
    ["Thanks for the invite. Not looking at tools right now but keep me posted on what you ship.", "Absolutely. I will check back in a couple of months."],
  ];
  const nwMessageRows: MsgRow[] = [];
  const nwConnections: (typeof connections.$inferInsert)[] = [];
  for (const [i, np] of networkPeople.entries()) {
    const account = rand.pick(accounts);
    const accountPlanRow = accountPlan.find((a) => a.key === account.key)!;
    const connectedAt = inWindow(ctx, daysAgo(ctx, rand.int(2, Math.min(85, accountPlanRow.daysAgo - 2))));
    const id = createId();
    const providerId = providerIdFor(rand);
    const chatId = i % 3 === 0 ? null : chatIdFor(rand);
    let updatedAt = connectedAt;
    if (chatId && i % 4 === 1 && nwMessageRows.length < 24) {
      const [theirs, ours] = rand.pick(networkMessageTexts);
      const t1 = plus(connectedAt, rand.int(30, 2000));
      const t2 = plus(t1, rand.int(20, 400));
      if (ms(t2) < ms(nowCap)) {
        const unseen = false;
        nwMessageRows.push({ organizationId: org, type: "RECEIVED", text: theirs, linkedinMessageId: messageIdFor(rand), connectionId: id, leadId: null, seen: !unseen, createdAt: t1 });
        if (rand.chance(0.75)) {
          nwMessageRows.push({
            organizationId: org,
            type: "CUSTOM_SENT",
            text: ours.replaceAll("{lead}", np.name.split(" ")[0]),
            linkedinMessageId: messageIdFor(rand),
            connectionId: id,
            leadId: null,
            seen: true,
            createdAt: t2,
          });
          updatedAt = t2;
        } else updatedAt = t1;
      }
    }
    nwConnections.push({
      organizationId: org,
      id,
      providerId,
      name: np.name,
      headline: np.headline,
      profilePictureUrl: null,
      linkedinUrl: profileUrl(np.slug),
      chatId,
      leadId: null,
      linkedinAccountId: account.id,
      connectedAt,
      createdAt: connectedAt,
      updatedAt,
    });
    ledger.push({
      kind: "accepted",
      at: connectedAt,
      accountLinkedinId: account.linkedinId,
      accountUsername: account.username,
      providerId,
      name: np.name,
      headline: np.headline,
      slug: np.slug,
      pictureUrl: null,
      chatId: chatId ?? "",
      connectionId: id,
      hasLead: false,
    });
  }

  // ------------------------------------------------------------ write it all
  await insertChunks(leadRows, 100, (c) => db.insert(leads).values(c));
  await insertChunks([...connectionRows, ...nwConnections], 100, (c) => db.insert(connections).values(c));
  await insertChunks([...messageRows, ...nwMessageRows], 200, (c) => db.insert(messages).values(c));
  count(ctx, "LinkedIn campaigns", PLANS.length);
  count(ctx, "LinkedIn leads", leadRows.length);
  count(ctx, "LinkedIn connections", connectionRows.length + nwConnections.length);
  count(ctx, "LinkedIn messages", messageRows.length + nwMessageRows.length);

  // ----------------------------------------------- replies into the CRM
  repliers.sort((a, b) => ms(a.inbound[0].at) - ms(b.inbound[0].at));
  for (const r of repliers) {
    let result: Awaited<ReturnType<typeof ingestInboundReply>> | null = null;
    for (const m of r.inbound) {
      result = await ingestInboundReply({
        personId: r.person.id,
        channel: "linkedin",
        accountRef: r.accountLinkedinId,
        providerThreadId: r.chatId,
        providerContactId: r.providerId,
        idempotencyKey: m.lmid,
        providerMessageId: m.lmid,
        bodyText: m.text,
        raw: {
          personId: r.person.id,
          providerId: r.providerId,
          name: r.person.fullName,
          headline: r.headline,
          linkedinUrl: profileUrl(r.person.linkedinSlug),
          chatId: r.chatId,
          accountId: r.accountLinkedinId,
          accountUsername: r.accountUsername,
          messageText: m.text,
          linkedinMessageId: m.lmid,
          sentAt: m.at.toISOString(),
        },
        sentAt: m.at,
        actorRef: "unipile",
      });
    }
    if (result) {
      const last = r.inbound[r.inbound.length - 1];
      ctx.replies.push({
        recordId: result.record.id,
        personId: r.person.id,
        conversationId: result.conversation.id,
        messageId: result.message.id,
        channel: "linkedin",
        intent: r.intent,
        sentAt: last.at,
        rep: r.rep,
      });
    }
  }
  count(ctx, "LinkedIn replies handed to the CRM", repliers.length);

  // ------------------------------------------------------------------ search
  await seedSearch(ctx, accounts);

  // --------------------------------------------------- webhooks and job history
  await seedWebhooks(ctx, ledger);
  await seedJobs(ctx, accounts, sendEvents);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function seedSearch(ctx: DemoContext, accounts: AccountRow[]) {
  const { rand, now } = ctx;
  const org = ctx.organizationId;
  const europe = new Set(["UK", "DE", "NL", "FR", "SE", "ES", "IE"]);

  const plans: {
    name: string;
    createdDays: number;
    filter: (c: DemoContext["companies"][number]) => boolean;
    fallback: (c: DemoContext["companies"][number]) => boolean;
    titles: string[];
    accountKeys: TeamKey[];
    queries: number;
  }[] = [
    {
      name: "Heads of Sales · SaaS · 50–200 · US",
      createdDays: 4.3,
      filter: (c) => c.industry === "B2B SaaS" && c.country === "US" && c.employees >= 50 && c.employees <= 250,
      fallback: (c) => c.country === "US" && (c.industry === "B2B SaaS" || c.industry === "Developer tools" || c.industry === "Martech"),
      titles: ["Head of Sales", "VP of Sales", "Director of Sales Development", "Chief Revenue Officer", "Founder & CEO"],
      accountKeys: ["alex", "priya"],
      queries: 9,
    },
    {
      name: "RevOps · Fintech · Europe",
      createdDays: 1.6,
      filter: (c) => c.industry === "Fintech" && europe.has(c.country),
      fallback: (c) => europe.has(c.country) && (c.industry === "Fintech" || c.industry === "Insurtech" || c.industry === "B2B SaaS"),
      titles: ["Revenue Operations Manager", "VP of Revenue Operations", "Sales Operations Lead", "Head of Revenue Operations", "Director of Sales Operations"],
      accountKeys: ["priya", "sam"],
      queries: 8,
    },
  ];

  searchRuns.length = 0;
  const usedCompanies = new Set<string>();
  for (const plan of plans) {
    let chosen = ctx.companies.filter(plan.filter);
    for (const c of ctx.companies.filter(plan.fallback)) if (chosen.length < plan.queries && !chosen.includes(c)) chosen.push(c);
    chosen = rand.shuffle(chosen).filter((c) => !usedCompanies.has(c.slug)).slice(0, plan.queries);
    for (const c of chosen) usedCompanies.add(c.slug);

    const batchId = createId();
    const createdAt = inWindow(ctx, daysAgoFrac(ctx, plan.createdDays));
    const accs = plan.accountKeys.map((k) => accounts.find((a) => a.key === k)!);
    const queryRows: (typeof searchQueries.$inferInsert)[] = [];
    const resultRows: (typeof searchResults.$inferInsert)[] = [];
    let cursor = plus(createdAt, rand.int(2, 6));
    for (const company of chosen) {
      const queryId = createId();
      const startedAt = cursor;
      const fetched = rand.int(5, 12);
      const completedAt = plus(startedAt, rand.int(1, 4));
      cursor = plus(completedAt, rand.int(0, 2));
      const account = rand.pick(accs);
      const keyword = `${plan.titles[0]} ${company.name}`.replaceAll(" ", "%20");
      queryRows.push({
        id: queryId,
        batchId,
        url: `https://www.linkedin.com/search/results/people/?keywords=${keyword}&origin=GLOBAL_SEARCH_HEADER`,
        companyName: company.name,
        status: "COMPLETED",
        totalCount: fetched + rand.int(0, 6),
        leadsFetched: fetched,
        currentAccountId: account.id,
        createdAt,
        updatedAt: completedAt,
        startedAt,
        completedAt,
      });
      const titles = rand.shuffle(plan.titles).slice(0, fetched);
      while (titles.length < fetched) titles.push(rand.pick(plan.titles));
      const seen = new Set<string>();
      for (const title of titles) {
        const female = rand.chance(0.48);
        const first = rand.pick(female ? FEMALE_FIRST : MALE_FIRST);
        const last = rand.pick(LAST_NAMES);
        const name = `${first} ${last}`;
        if (seen.has(name)) continue;
        seen.add(name);
        const slug = `${first}-${last}-${rid(rand, 5)}`.toLowerCase().replace(/[^a-z0-9-]/g, "x");
        const portrait = rand.chance(0.6) ? `https://randomuser.me/api/portraits/${female ? "women" : "men"}/${rand.int(1, 99)}.jpg` : null;
        resultRows.push({
          searchQueryId: queryId,
          linkedinUrl: providerIdFor(rand),
          name,
          headline: `${title} at ${company.name}`,
          location: company.hq,
          profilePictureUrl: portrait,
          networkDistance: rand.weighted([["DISTANCE_2", 62], ["DISTANCE_3", 28], ["DISTANCE_1", 10]]),
          followersCount: rand.int(180, title.includes("Founder") ? 9000 : 4200),
          sharedConnectionsCount: rand.weighted([[0, 25], [rand.int(1, 6), 45], [rand.int(7, 24), 30]]),
          raw: { public_identifier: slug, public_profile_url: profileUrl(slug), network_distance: "DISTANCE_2" },
          createdAt: completedAt,
        });
      }
    }
    await db.insert(searchBatches).values({
      organizationId: org,
      id: batchId,
      name: plan.name,
      kind: "BULK",
      accountIds: accs.map((a) => a.id),
      createdAt,
      updatedAt: cursor,
    });
    await db.insert(searchQueries).values(queryRows);
    await insertChunks(resultRows, 150, (c) => db.insert(searchResults).values(c));
    count(ctx, "LinkedIn search batches", 1);
    count(ctx, "LinkedIn search results", resultRows.length);
    searchRuns.push({ at: createdAt, queries: queryRows.map((q) => ({ url: q.url, fetched: q.leadsFetched ?? 0, account: accs[0].username })), accountsUsed: accs.map((a) => a.username) });
  }
  void now;
}

const searchRuns: { at: Date; queries: { url: string; fetched: number; account: string }[]; accountsUsed: string[] }[] = [];

function daysAgoFrac(ctx: DemoContext, days: number): Date {
  return new Date(ms(ctx.now) - days * DAY);
}

// ---------------------------------------------------------------------------
// Webhook ledger
// ---------------------------------------------------------------------------

async function seedWebhooks(ctx: DemoContext, ledger: LedgerEntry[]) {
  const { rand } = ctx;
  const org = ctx.organizationId;
  const accepted = ledger.filter((e) => e.kind === "accepted").sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 18);
  const replies = ledger.filter((e) => e.kind === "reply").sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 16);
  const echoes = ledger.filter((e) => e.kind === "echo").sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 6);
  const picked = [...accepted, ...replies, ...echoes].sort((a, b) => ms(a.at) - ms(b.at));

  const rows: (typeof webhookEvents.$inferInsert)[] = picked.map((e) => {
    const stamp = (offsetSec: number) => new Date(ms(e.at) + offsetSec * 1000).toISOString();
    const processedAt = new Date(ms(e.at) + rand.int(1, 4) * 1000 + rand.int(0, 900));
    if (e.kind === "accepted") {
      const timestamp = e.at.toISOString();
      const rawBody = {
        event: "new_relation",
        account_id: e.accountLinkedinId,
        account_type: "LINKEDIN",
        webhook_name: "AgentSDR connection accepted",
        user_provider_id: e.providerId,
        user_full_name: e.name,
        user_public_identifier: e.slug,
        user_profile_url: profileUrl(e.slug),
        user_picture_url: e.pictureUrl,
        timestamp,
      };
      const log = e.hasLead
        ? [
            ["info", "new_relation event received — processing connection acceptance", 0],
            ["info", `Sender provider ID: ${e.providerId}`, 0],
            ["info", `Account LinkedIn ID: ${e.accountLinkedinId}`, 0],
            ["info", `Matched account: @${e.accountUsername}`, 0],
            ["info", `Lead found in DB: ${profileUrl(e.slug)} (status: REQUEST_SENT)`, 0],
            ["info", `Looking up chatId via Unipile for sender ${e.providerId}`, 1],
            ["info", `chatId resolved: ${e.chatId}`, 1],
            ["info", `Connection upserted: id=${e.connectionId}`, 1],
            ["info", "Lead status advanced: REQUEST_SENT → ACCEPT_MESSAGE_SENT", 2],
          ]
        : [
            ["info", "new_relation event received — processing connection acceptance", 0],
            ["info", `Sender provider ID: ${e.providerId}`, 0],
            ["info", `Account LinkedIn ID: ${e.accountLinkedinId}`, 0],
            ["info", `Matched account: @${e.accountUsername}`, 0],
            ["warn", `No lead found for providerId=${e.providerId} — connection will be recorded without lead`, 0],
            ["info", `Connection upserted: id=${e.connectionId}`, 1],
            ["info", "No lead in system — connection recorded, nothing more to do", 1],
          ];
      return {
        organizationId: org,
        providerEventKey: `linkedin:LINKEDIN:new_relation:v1:${e.accountLinkedinId}:${e.providerId}:${timestamp}`,
        event: "new_relation",
        accountType: "LINKEDIN",
        accountId: e.accountLinkedinId,
        senderId: e.providerId,
        chatId: null,
        messageText: null,
        rawBody,
        connectionId: e.connectionId,
        processingLog: log.map(([level, message, off]) => ({ level, message, time: stamp(off as number) })),
        processingStatus: "ok",
        processingAttempt: 1,
        processedAt,
        createdAt: e.at,
      };
    }
    const isEcho = e.kind === "echo";
    const messageId = e.lmid!;
    const text = e.text ?? "";
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const rawBody = {
      event: "message_received",
      account_id: e.accountLinkedinId,
      account_type: "LINKEDIN",
      webhook_name: "AgentSDR messages",
      chat_id: e.chatId,
      message_id: messageId,
      message: text,
      timestamp: e.at.toISOString(),
      is_sender: isEcho,
      account_info: { type: "LINKEDIN", feature: "classic", user_id: "ACoAA" + e.accountLinkedinId.slice(3, 11) },
      sender: {
        attendee_id: isEcho ? "self" : e.providerId.slice(5, 17),
        attendee_name: isEcho ? e.accountUsername : e.name,
        attendee_provider_id: isEcho ? "ACoAA" + e.accountLinkedinId.slice(3, 11) : e.providerId,
        attendee_profile_url: isEcho ? null : profileUrl(e.slug),
        attendee_specifics: { occupation: isEcho ? null : e.headline },
      },
      attendees: [{ attendee_provider_id: e.providerId, attendee_name: e.name }],
    };
    const log = isEcho
      ? [
          ["info", "message_received event — processing inbound message", 0],
          ["info", `is_sender=true detected — using counterparty providerId: ${e.providerId}`, 0],
          ["info", `Matched account: @${e.accountUsername}`, 0],
          ["info", `Lead found: ${profileUrl(e.slug)} (status: ${e.leadStatus})`, 0],
          ["info", `Connection upserted: id=${e.connectionId}`, 1],
          ["info", `Message from ourselves (is_sender=true) in status ${e.leadStatus} — skipping echo of our own sent message`, 1],
        ]
      : [
          ["info", "message_received event — processing inbound message", 0],
          ["info", `Sender: ${e.name} | chatId: ${e.chatId} | message: "${preview}"`, 0],
          ["info", `Matched account: @${e.accountUsername}`, 0],
          ["info", `Lead found: ${profileUrl(e.slug)} (status: ${e.leadStatus})`, 0],
          ["info", `Connection upserted: id=${e.connectionId}`, 1],
          e.leadStatus === "REPLIED"
            ? ["info", "Follow-up inbound message saved on REPLIED thread", 2]
            : ["info", `Genuine reply received — advancing to REPLIED (was: ${e.leadStatus})`, 2],
          ...(e.leadStatus === "REPLIED" ? [] : [["info", `Lead status advanced: ${e.leadStatus} → REPLIED`, 2]]),
        ];
    return {
      organizationId: org,
      providerEventKey: `linkedin:LINKEDIN:message_received:v1:${e.accountLinkedinId}:${messageId}`,
      event: "message_received",
      accountType: "LINKEDIN",
      accountId: e.accountLinkedinId,
      senderId: isEcho ? "ACoAA" + e.accountLinkedinId.slice(3, 11) : e.providerId,
      chatId: e.chatId,
      messageText: text,
      rawBody,
      connectionId: e.connectionId,
      processingLog: (log as [string, string, number][]).map(([level, message, off]) => ({ level, message, time: stamp(off) })),
      processingStatus: isEcho ? "skipped" : "ok",
      processingAttempt: 1,
      processedAt,
      createdAt: e.at,
    };
  });
  await insertChunks(rows, 50, (c) => db.insert(webhookEvents).values(c));
  count(ctx, "LinkedIn webhook events", rows.length);
}

// ---------------------------------------------------------------------------
// Job history
// ---------------------------------------------------------------------------

async function seedJobs(ctx: DemoContext, accounts: AccountRow[], events: SendEvent[]) {
  const { rand, now } = ctx;
  const from = new Date(ms(now) - 5 * DAY);
  const runs: (typeof jobRuns.$inferInsert)[] = [];
  const logs: (typeof jobLogs.$inferInsert)[] = [];

  const addRun = (job: string, startedAt: Date, entries: [string, string][], opts: { error?: string; seconds?: number } = {}) => {
    const id = createId();
    const seconds = opts.seconds ?? rand.int(4, 40);
    const finishedAt = new Date(ms(startedAt) + seconds * 1000 + rand.int(0, 900));
    runs.push({ id, job, status: opts.error ? "FAILED" : "SUCCESS", startedAt, finishedAt, error: opts.error ?? null });
    entries.forEach(([level, message], i) => {
      const t = new Date(ms(startedAt) + Math.round(((i + 1) / (entries.length + 1)) * (seconds * 1000)));
      logs.push({ jobRunId: id, level, message, createdAt: t });
    });
  };

  const accountOrder: TeamKey[] = ["alex", "priya", "sam"];
  const hhmm = (d: Date) => {
    const local = new Date(ms(d) - 4 * HOUR);
    const h = local.getUTCHours();
    return `${((h + 11) % 12) + 1}:${String(local.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  const invitesByAccountDay = new Map<string, number>();
  for (const e of events.filter((x) => x.kind === "invite")) {
    const key = `${e.accountKey}:${new Date(ms(e.at) - 4 * HOUR).toISOString().slice(0, 10)}`;
    invitesByAccountDay.set(key, (invitesByAccountDay.get(key) ?? 0) + 1);
  }
  const usedSoFar = new Map<string, number>();

  const recent = events.filter((e) => ms(e.at) >= ms(from)).sort((a, b) => ms(a.at) - ms(b.at));
  let failedRunDone = false;

  // run-outreach: a run every half hour through each working day.
  const dayStart = new Date(from);
  dayStart.setUTCHours(0, 0, 0, 0);
  for (let day = 0; day <= 6; day++) {
    const base = new Date(ms(dayStart) + day * DAY);
    if (base.getUTCDay() === 0 || base.getUTCDay() === 6) continue;
    for (let slot = 0; slot < 18; slot++) {
      const slotStart = new Date(ms(base) + 13 * HOUR + slot * 30 * MINUTE);
      const slotEnd = new Date(ms(slotStart) + 30 * MINUTE);
      if (ms(slotStart) < ms(from) || ms(slotEnd) > ms(now) - 2 * MINUTE) continue;
      const inSlot = recent.filter((e) => ms(e.at) >= ms(slotStart) && ms(e.at) < ms(slotEnd));
      const startedAt = inSlot.length ? new Date(ms(inSlot[0].at) - rand.int(60, 180) * 1000) : new Date(ms(slotStart) + rand.int(20, 280) * 1000);
      const entries: [string, string][] = [
        ["info", "[runOutreach] Starting outreach job"],
        ["info", `[runOutreach] Running pipeline for ${accounts.length} account(s)`],
      ];
      for (const key of accountOrder) {
        const acc = accounts.find((a) => a.key === key)!;
        const mine = inSlot.filter((e) => e.accountKey === key);
        entries.push(["info", `[runOutreach] ── Account: ${acc.username} ──`]);
        if (!mine.length) {
          entries.push(["info", `[runOutreach] Cooldown active — next allowed run ${hhmm(plus(startedAt, rand.int(6, 26)))} — skipping`]);
          continue;
        }
        const limit = acc.premium ? 30 : 5;
        const dayKey = `${key}:${new Date(ms(startedAt) - 4 * HOUR).toISOString().slice(0, 10)}`;
        const used = usedSoFar.get(dayKey) ?? 0;
        const invites = mine.filter((e) => e.kind === "invite");
        if (invites.length) {
          entries.push(["info", `[sendInvitations] Processing account ${acc.username} (${acc.premium ? "premium" : "free"}, limit: ${limit}/day)`]);
          entries.push(["info", `[sendInvitations] Sending up to ${invites.length} requests (${used}/${limit} used today)`]);
          for (const e of invites) entries.push(["info", `[sendInvitations] Request sent to ${e.url} (${e.providerId})`]);
          usedSoFar.set(dayKey, used + invites.length);
        }
        const fus = mine.filter((e) => e.kind !== "invite");
        if (fus.length) {
          entries.push(["info", `[sendFollowUps] Processing account ${acc.username}`]);
          for (const kind of ["fu1", "fu2", "fu3"] as const) {
            const group = fus.filter((e) => e.kind === kind);
            if (!group.length) continue;
            const label = `Follow-up ${kind.slice(2)}`;
            entries.push(["info", `[sendFollowUps] ${label}: sending to ${group.length} lead(s)`]);
            for (const e of group) entries.push(["info", `[sendFollowUps] ${label} sent to ${e.url}${e.complete ? " — sequence complete" : ""}`]);
          }
        }
        if (rand.chance(0.06)) entries.push(["warn", `[sendFollowUps] Follow-up 1: no chatId for ${mine[0].url}, will retry`]);
        entries.push(["info", `[runOutreach] Scheduled next run for @${acc.username} after ${hhmm(plus(startedAt, rand.int(14, 34)))}`]);
      }
      const seconds = Math.max(6, inSlot.length * rand.int(6, 12) + rand.int(3, 15));
      // One timeout, a day or so back: the platform recovered on the next run.
      if (!failedRunDone && !inSlot.length && ms(now) - ms(startedAt) > 2.5 * DAY && ms(now) - ms(startedAt) < 3.4 * DAY) {
        failedRunDone = true;
        const err = "FetchError: request to Unipile timed out after 30000ms (ETIMEDOUT)";
        addRun("run-outreach", startedAt, [...entries.slice(0, 3), ["error", `[sendInvitations] Failed for account: ${err}`]], { error: err, seconds: 31 });
        continue;
      }
      addRun("run-outreach", startedAt, entries, { seconds });
    }
  }

  // Sends outside the half-hour slots above (today's early invitations) still came from a run.
  {
    const covered = new Set(runs.map((r) => Math.floor(ms(r.startedAt as Date) / (30 * MINUTE))));
    const orphans = recent.filter((e) => !covered.has(Math.floor(ms(e.at) / (30 * MINUTE))));
    const byBucket = new Map<number, SendEvent[]>();
    for (const e of orphans) {
      const k = Math.floor(ms(e.at) / (30 * MINUTE));
      byBucket.set(k, [...(byBucket.get(k) ?? []), e]);
    }
    for (const group of byBucket.values()) {
      const startedAt = new Date(ms(group[0].at) - rand.int(60, 150) * 1000);
      const entries: [string, string][] = [["info", "[runOutreach] Starting outreach job"], ["info", `[runOutreach] Running pipeline for ${accounts.length} account(s)`]];
      for (const key of accountOrder) {
        const acc = accounts.find((a) => a.key === key)!;
        const mine = group.filter((e) => e.accountKey === key);
        entries.push(["info", `[runOutreach] ── Account: ${acc.username} ──`]);
        if (!mine.length) {
          entries.push(["info", `[runOutreach] Cooldown active — next allowed run ${hhmm(plus(startedAt, rand.int(6, 26)))} — skipping`]);
          continue;
        }
        const limit = acc.premium ? 30 : 5;
        const dayKey = `${key}:${new Date(ms(startedAt) - 4 * HOUR).toISOString().slice(0, 10)}`;
        const used = usedSoFar.get(dayKey) ?? 0;
        const invites = mine.filter((e) => e.kind === "invite");
        if (invites.length) {
          entries.push(["info", `[sendInvitations] Processing account ${acc.username} (${acc.premium ? "premium" : "free"}, limit: ${limit}/day)`]);
          entries.push(["info", `[sendInvitations] Sending up to ${invites.length} requests (${used}/${limit} used today)`]);
          for (const e of invites) entries.push(["info", `[sendInvitations] Request sent to ${e.url} (${e.providerId})`]);
          usedSoFar.set(dayKey, used + invites.length);
        }
        entries.push(["info", `[runOutreach] Scheduled next run for @${acc.username} after ${hhmm(plus(startedAt, rand.int(14, 34)))}`]);
      }
      addRun("run-outreach", startedAt, entries, { seconds: group.length * rand.int(6, 12) + rand.int(3, 15) });
    }
  }

  // reset-daily-limits at 00:05 UTC.
  for (let day = 0; day <= 6; day++) {
    const t = new Date(ms(dayStart) + day * DAY + 5 * MINUTE + rand.int(0, 50) * 1000);
    if (ms(t) < ms(from) || ms(t) > ms(now)) continue;
    addRun(
      "reset-daily-limits",
      t,
      [
        ["info", "[resetDailyLimits] Starting job"],
        ["info", `[resetDailyLimits] Reset limitReached and searchLeadsToday for ${accounts.length} account(s)`],
        ["info", `[resetDailyLimits] Pruned ${rand.int(18, 64)} webhook event(s) older than 1 day(s)`],
        ["info", `[resetDailyLimits] Pruned ${rand.int(30, 52)} job run(s) older than 1 day(s)`],
      ],
      { seconds: rand.int(2, 6) },
    );
  }

  // run-search-queue: the real runs for each batch, plus the idle checks around them.
  for (const sr of searchRuns) {
    const entries: [string, string][] = [
      ["info", "[runSearchQueue] Starting"],
      ["info", `[runSearchQueue] Using, in order: ${sr.accountsUsed.map((u) => `@${u}`).join(", ")}`],
      ["info", `[runSearchQueue] ${sr.queries.length} search(es) to run across ${sr.accountsUsed.length} account(s), ${sr.accountsUsed.length} at a time`],
    ];
    for (const q of sr.queries) {
      entries.push(["info", `[runSearchQueue] ── "${q.url}" ──`]);
      entries.push(["info", `[runSearchQueue] "${q.url}" complete — ${q.fetched} lead(s) fetched`]);
    }
    entries.push(["info", "[runSearchQueue] Job complete"]);
    addRun("run-search-queue", plus(sr.at, 2), entries, { seconds: sr.queries.length * rand.int(25, 40) });
  }
  for (let i = 0; i < 6; i++) {
    const t = workTime(ctx, rand.int(0, 4));
    if (ms(t) < ms(from)) continue;
    addRun("run-search-queue", t, [["info", "[runSearchQueue] Starting"], ["info", "[runSearchQueue] Nothing queued, stopping"], ["info", "[runSearchQueue] Job complete"]], { seconds: 2 });
  }

  await insertChunks(runs, 100, (c) => db.insert(jobRuns).values(c));
  await insertChunks(logs, 300, (c) => db.insert(jobLogs).values(c));
  count(ctx, "LinkedIn job runs", runs.length);
}
