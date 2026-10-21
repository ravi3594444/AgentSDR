/**
 * A request: one piece of outreach work the owner can follow from start to
 * finish, whatever started it. Most are an owner's message in a chat (its
 * searches and plans carry the message id); older plans and searches carry
 * none and stand alone; a campaign made by hand belongs to no run. Every one
 * gets a key the Requests page and the panel beside the chat both use:
 *
 *   r:<message id>                      a chat request (an objective, or plans carrying it)
 *   run:<run id>                        an older plan with no request id
 *   job:<job id>                        an older search with no request id
 *   campaign:<email|whatsapp|linkedin>:<id>   a manual campaign no run owns
 *
 * Pure: shared by the server (requests.server.ts) and the pages.
 */

export type RequestKey =
  | { kind: "request"; id: string }
  | { kind: "run"; id: string }
  | { kind: "job"; id: string }
  | { kind: "campaign"; channel: CampaignChannel; id: string };

export type CampaignChannel = "email" | "whatsapp" | "linkedin";
const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = ["email", "whatsapp", "linkedin"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// LinkedIn campaign ids are cuids (text), not uuids.
const CUID = /^[a-z0-9]{8,40}$/i;

export function parseRequestKey(key: string): RequestKey | null {
  const [prefix, a, b, ...rest] = key.split(":");
  if (rest.length) return null;
  if (prefix === "r" && a && b === undefined && UUID.test(a)) return { kind: "request", id: a };
  if (prefix === "run" && a && b === undefined && UUID.test(a)) return { kind: "run", id: a };
  if (prefix === "job" && a && b === undefined && UUID.test(a)) return { kind: "job", id: a };
  if (prefix === "campaign" && a && b && (CAMPAIGN_CHANNELS as readonly string[]).includes(a)) {
    const channel = a as CampaignChannel;
    if (channel === "linkedin" ? CUID.test(b) : UUID.test(b)) return { kind: "campaign", channel, id: b };
  }
  return null;
}

export function formatRequestKey(key: RequestKey): string {
  switch (key.kind) {
    case "request": return `r:${key.id}`;
    case "run": return `run:${key.id}`;
    case "job": return `job:${key.id}`;
    case "campaign": return `campaign:${key.channel}:${key.id}`;
  }
}

/** The figures beside a request. `matching` is null where nothing was searched for it (a list, a manual campaign). */
export type RequestNumbers = { matching: number | null; contacted: number; replied: number; interested: number; failed: number };

export type NextStepKind = "inbox" | "start" | "fix_sender" | "wait" | "paused" | "research" | "done" | "nothing";

/** What the owner can do next, as one button: where it goes, and why. */
export type NextStep = { kind: NextStepKind; label: string; href: string | null; detail: string | null };

/** What the next step is read from: everything already computed for the summary. */
export type NextStepFacts = {
  /** Conversations of this request waiting on a person (the Inbox's Needs you) plus its open decisions. */
  waitingInInbox: number;
  /** Plans prepared and waiting for Start, newest first. */
  awaitingStart: { name: string; threadId: string | null }[];
  /** An open plan whose senders cannot send: the reason. */
  senderProblem: string | null;
  /** The earliest time a held sender may send again, and why it waits. */
  waitingUntil: { at: string; label: string; reason: string | null } | null;
  /** An open plan that is paused. */
  paused: { name: string } | null;
  /** The request's research, paused by the owner (its objective), and the chat it is resumed from. */
  researchPaused: { threadId: string | null } | null;
  /** A search or the request's objective still running. */
  researching: boolean;
  /** Anything still open (a search, a plan with something to send, an objective). */
  open: boolean;
  /** How it ended, when it did (the objective's stop reason, a plan's outcome). */
  outcome: string | null;
};

/**
 * The one next step for a request, the first that applies: answer what waits
 * in the Inbox; press Start on a prepared plan; fix a sender that cannot
 * send; wait for a sender's hours or limits; resume a paused plan, then
 * paused research (from the chat: no button resumes it elsewhere); let the
 * research run; else it is done (or there is nothing to do).
 */
export function nextActionFor(facts: NextStepFacts, chatHref: (threadId: string) => string = (id) => `/assistant?thread=${encodeURIComponent(id)}`): NextStep {
  if (facts.waitingInInbox > 0) {
    const n = facts.waitingInInbox;
    return { kind: "inbox", label: `Answer ${n} in the Inbox`, href: "/inbox?view=needs_you", detail: `${n} ${n === 1 ? "conversation or decision waits" : "conversations or decisions wait"} for you.` };
  }
  const plan = facts.awaitingStart[0];
  if (plan) {
    const more = facts.awaitingStart.length - 1;
    return { kind: "start", label: `Press Start on “${plan.name}”`, href: plan.threadId ? chatHref(plan.threadId) : null, detail: more > 0 ? `${more} more ${more === 1 ? "plan waits" : "plans wait"} for Start too.` : "Nothing is sent until you press Start." };
  }
  if (facts.senderProblem) return { kind: "fix_sender", label: "Fix the sender", href: "/getting-started", detail: facts.senderProblem };
  if (facts.waitingUntil) return { kind: "wait", label: `Waiting until ${facts.waitingUntil.label}`, href: null, detail: facts.waitingUntil.reason };
  if (facts.paused) return { kind: "paused", label: `Resume “${facts.paused.name}” when ready`, href: null, detail: "It is paused; nothing is sent until you resume it." };
  if (facts.researchPaused) {
    return { kind: "paused", label: "Resume the research when ready", href: facts.researchPaused.threadId ? chatHref(facts.researchPaused.threadId) : null, detail: "It is paused: searches already running finish, and nothing new is searched until you resume it in the chat." };
  }
  if (facts.researching) return { kind: "research", label: "Research is running", href: null, detail: "Searches are still finding and checking leads." };
  if (facts.open) return { kind: "wait", label: "Sending", href: null, detail: "Messages go out within each channel's hours and daily limits." };
  if (facts.outcome) return { kind: "done", label: "Done", href: null, detail: facts.outcome };
  return { kind: "nothing", label: "Nothing to do", href: null, detail: null };
}

/** What a request's state is read from: its work items (newest first) and its objective, when it has one. */
export type RequestStateFacts = {
  items: readonly { type: "job" | "plan"; state: string; stateLabel: string; open: boolean }[];
  objective: { status: "active" | "paused" | "stopped"; waiting: string | null } | null;
};

/**
 * The state a request shows: its first open plan's, else its first open
 * search's; else, while its objective still runs (between one search
 * ending and the continuation starting the next, or paused), researching
 * with the objective's waiting reason; else its newest item's. Open while
 * any of those holds, so a request never reads Done from a finished child
 * while its research goes on (pilot finding L03).
 */
export function requestState(facts: RequestStateFacts): { state: string; stateLabel: string; open: boolean } {
  const lead = facts.items.find((item) => item.open && item.type === "plan") ?? facts.items.find((item) => item.open);
  if (lead) return { state: lead.state, stateLabel: lead.stateLabel, open: true };
  if (facts.objective?.status === "active") return { state: "researching", stateLabel: facts.objective.waiting ? `Researching (${facts.objective.waiting})` : "Researching", open: true };
  if (facts.objective?.status === "paused") return { state: "paused", stateLabel: "Research paused", open: true };
  const newest = facts.items[0];
  return newest ? { state: newest.state, stateLabel: newest.stateLabel, open: false } : { state: "completed", stateLabel: "Finished", open: false };
}
