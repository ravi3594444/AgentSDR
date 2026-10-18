import { describe, expect, test } from "bun:test";
import { createResponseGate } from "./responseGate";

/** A request whose answer the test releases by hand, in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The Action required list's load, reduced to what the gate decides: which answers land. */
function list() {
  const gate = createResponseGate();
  const shown: { rows: string[]; counts: string | null } = { rows: [], counts: null };
  const pending = new Map<string, ReturnType<typeof deferred<string[]>>>();
  async function load(key: string, firstPage: boolean) {
    const ticket = firstPage ? gate.restart() : gate.follow();
    if (ticket === null) return "skipped";
    const request = deferred<string[]>();
    pending.set(key, request);
    const rows = await request.promise;
    if (!gate.isCurrent(ticket)) return "dropped";
    shown.rows = firstPage ? rows : [...shown.rows, ...rows];
    if (firstPage) gate.land(ticket);
    return "applied";
  }
  async function reloadCounts(key: string) {
    const ticket = gate.follow();
    if (ticket === null) return "skipped";
    const request = deferred<string[]>();
    pending.set(key, request);
    const [counts] = await request.promise;
    if (!gate.isCurrent(ticket)) return "dropped";
    shown.counts = counts ?? null;
    return "applied";
  }
  return { shown, load, reloadCounts, answer: (key: string, rows: string[]) => pending.get(key)!.resolve(rows) };
}

describe("response gate", () => {
  test("a late answer to the default queue never replaces the Needs you view asked for after it", async () => {
    const view = list();
    const queue = view.load("actions", true);
    const needsYou = view.load("needs_you", true);
    view.answer("needs_you", ["n1"]);
    expect(await needsYou).toBe("applied");
    view.answer("actions", ["a1", "a2"]);
    expect(await queue).toBe("dropped");
    expect(view.shown.rows).toEqual(["n1"]);
  });

  test("answers in request order still land", async () => {
    const view = list();
    const queue = view.load("actions", true);
    view.answer("actions", ["a1"]);
    expect(await queue).toBe("applied");
    const more = view.load("actions-2", false);
    view.answer("actions-2", ["a2"]);
    expect(await more).toBe("applied");
    expect(view.shown.rows).toEqual(["a1", "a2"]);
  });

  test("a next page of the previous filter is dropped once a new filter is asked for", async () => {
    const view = list();
    const first = view.load("all", true);
    view.answer("all", ["a1"]);
    await first;
    const more = view.load("all-2", false);
    const errors = view.load("errors", true);
    view.answer("errors", ["e1"]);
    await errors;
    view.answer("all-2", ["a2"]);
    expect(await more).toBe("dropped");
    expect(view.shown.rows).toEqual(["e1"]);
  });

  test("no next page or count refresh is asked for while a new list's first page is loading", async () => {
    const view = list();
    const first = view.load("all", true);
    view.answer("all", ["a1"]);
    await first;
    const errors = view.load("errors", true);
    expect(await view.load("all-2", false)).toBe("skipped");
    expect(await view.reloadCounts("counts")).toBe("skipped");
    view.answer("errors", ["e1"]);
    await errors;
    const counts = view.reloadCounts("counts-2");
    view.answer("counts-2", ["needs_you:1"]);
    expect(await counts).toBe("applied");
    expect(view.shown.counts).toBe("needs_you:1");
  });

  test("a count refresh started before a new filter is dropped", async () => {
    const view = list();
    const first = view.load("all", true);
    view.answer("all", ["a1"]);
    await first;
    const counts = view.reloadCounts("counts");
    const errors = view.load("errors", true);
    view.answer("counts", ["stale"]);
    expect(await counts).toBe("dropped");
    view.answer("errors", ["e1"]);
    await errors;
    expect(view.shown.counts).toBeNull();
  });
});
