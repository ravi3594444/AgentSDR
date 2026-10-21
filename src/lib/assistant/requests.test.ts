import { describe, expect, test } from "bun:test";
import { formatRequestKey, nextActionFor, parseRequestKey, requestState, type NextStepFacts } from "./requests";

const id = "0b5e6c1e-6c55-4d1a-9b8f-3f7e3c1a2b4d";

describe("request keys", () => {
  test("each kind of work round-trips", () => {
    for (const key of [`r:${id}`, `run:${id}`, `job:${id}`, `campaign:email:${id}`, `campaign:whatsapp:${id}`, "campaign:linkedin:clx1abcd0000qwer5678tyui"]) {
      const parsed = parseRequestKey(key);
      expect(parsed).not.toBeNull();
      expect(formatRequestKey(parsed!)).toBe(key);
    }
  });

  test("anything else is refused", () => {
    for (const key of ["", "r:", "r:not-an-id", `x:${id}`, `run:${id}:extra`, `campaign:instagram:${id}`, "campaign:email:clx1abcd0000qwer5678tyui", "campaign:linkedin:../../etc", `r:${id}' or 1=1`]) {
      expect(parseRequestKey(key)).toBeNull();
    }
  });
});

const quiet: NextStepFacts = { waitingInInbox: 0, awaitingStart: [], senderProblem: null, waitingUntil: null, paused: null, researchPaused: null, researching: false, open: false, outcome: null };

describe("the next step: the first that applies", () => {
  test("what waits in the Inbox comes first", () => {
    const step = nextActionFor({ ...quiet, waitingInInbox: 3, awaitingStart: [{ name: "Chicago", threadId: "t" }], researching: true });
    expect(step).toMatchObject({ kind: "inbox", label: "Answer 3 in the Inbox", href: "/inbox?view=needs_you" });
  });

  test("then a plan waiting for Start, linked to its chat", () => {
    const step = nextActionFor({ ...quiet, awaitingStart: [{ name: "Chicago dentists", threadId: "t1" }, { name: "Austin", threadId: "t2" }], senderProblem: "disconnected" });
    expect(step.kind).toBe("start");
    expect(step.label).toBe("Press Start on “Chicago dentists”");
    expect(step.href).toBe("/assistant?thread=t1");
    expect(step.detail).toContain("1 more plan waits");
  });

  test("then a sender that cannot send", () => {
    expect(nextActionFor({ ...quiet, senderProblem: "the mailbox is disconnected", waitingUntil: { at: "x", label: "9:00", reason: null } })).toMatchObject({ kind: "fix_sender", href: "/getting-started", detail: "the mailbox is disconnected" });
  });

  test("then waiting for a sender's hours, with the time", () => {
    expect(nextActionFor({ ...quiet, waitingUntil: { at: "2026-10-21T09:00:00Z", label: "Tue 9:00", reason: "every sender is outside its sending hours" }, researching: true })).toMatchObject({ kind: "wait", label: "Waiting until Tue 9:00", detail: "every sender is outside its sending hours" });
  });

  test("then a paused plan, then research, then sending", () => {
    expect(nextActionFor({ ...quiet, paused: { name: "Chicago" }, researching: true }).kind).toBe("paused");
    expect(nextActionFor({ ...quiet, researching: true, open: true }).kind).toBe("research");
    expect(nextActionFor({ ...quiet, open: true }).label).toBe("Sending");
  });

  // Review of pilot L03: research the owner paused, with every search
  // finished, read "Done" as its next step while the panel said paused.
  test("research the owner paused: resume it in the chat, never Done", () => {
    const step = nextActionFor({ ...quiet, researchPaused: { threadId: "t1" }, outcome: "Done" });
    expect(step).toMatchObject({ kind: "paused", label: "Resume the research when ready", href: "/assistant?thread=t1" });
    expect(step.detail).toContain("nothing new is searched until you resume it");
    expect(nextActionFor({ ...quiet, researchPaused: { threadId: null } }).href).toBeNull();
    // A paused plan is named first (its card resumes it); paused research comes before a search still finishing.
    expect(nextActionFor({ ...quiet, paused: { name: "Chicago" }, researchPaused: { threadId: "t1" } }).label).toContain("Chicago");
    expect(nextActionFor({ ...quiet, researchPaused: { threadId: "t1" }, researching: true, open: true }).kind).toBe("paused");
  });

  test("done says how it ended; nothing open and no outcome is nothing to do", () => {
    expect(nextActionFor({ ...quiet, outcome: "the target of 20 was reached" })).toMatchObject({ kind: "done", detail: "the target of 20 was reached" });
    expect(nextActionFor(quiet).kind).toBe("nothing");
  });
});

// Pilot finding L03: between one search ending and the continuation
// starting the next, a request has no open child but its objective still
// runs; it must read as working, not as its finished child.
describe("requestState: what a request shows while its research runs", () => {
  const item = (type: "job" | "plan", state: string, stateLabel: string, open: boolean) => ({ type, state, stateLabel, open });
  const done = [item("job", "completed", "Done", false)];

  test("an open plan leads, then an open search", () => {
    expect(requestState({ items: [item("job", "executing", "Working", true), item("plan", "waiting_send", "Waiting to send", true)], objective: { status: "active", waiting: null } })).toEqual({ state: "waiting_send", stateLabel: "Waiting to send", open: true });
    expect(requestState({ items: [item("job", "queued", "Queued", true), ...done], objective: null })).toEqual({ state: "queued", stateLabel: "Queued", open: true });
  });

  test("every child finished while the objective is active: open and researching, with its waiting reason", () => {
    expect(requestState({ items: done, objective: { status: "active", waiting: null } })).toEqual({ state: "researching", stateLabel: "Researching", open: true });
    expect(requestState({ items: done, objective: { status: "active", waiting: "the assistant is choosing the next source" } })).toEqual({ state: "researching", stateLabel: "Researching (the assistant is choosing the next source)", open: true });
    expect(requestState({ items: [], objective: { status: "active", waiting: null } }).open).toBe(true);
  });

  test("a paused objective keeps it open too", () => {
    expect(requestState({ items: done, objective: { status: "paused", waiting: null } })).toEqual({ state: "paused", stateLabel: "Research paused", open: true });
  });

  test("once the objective stopped, the newest child says how it ended; nothing at all is finished", () => {
    expect(requestState({ items: done, objective: { status: "stopped", waiting: null } })).toEqual({ state: "completed", stateLabel: "Done", open: false });
    expect(requestState({ items: [item("plan", "failed", "Failed", false), ...done], objective: null })).toEqual({ state: "failed", stateLabel: "Failed", open: false });
    expect(requestState({ items: [], objective: { status: "stopped", waiting: null } })).toEqual({ state: "completed", stateLabel: "Finished", open: false });
  });
});
