import { describe, expect, test } from "bun:test";
import { createResponseGate } from "./responseGate";

/** A request whose answer (or failure) the test releases by hand, in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Page = { rows: string[]; hasMore: boolean };

/**
 * The Action required list's handlers (CrmActionsClient's load, reloadCounts
 * and onMutated), reduced to what decides which answers land. `query` is the
 * list asked for last; each request records the query it was made for.
 */
function list() {
  const gate = createResponseGate();
  const shown: { rows: string[]; counts: string | null; hasMore: boolean; error: string | null } = { rows: [], counts: null, hasMore: false, error: null };
  const pending = new Map<string, ReturnType<typeof deferred<Page>>>();
  const requestedFor = new Map<string, string>();
  let query = "";
  async function load(key: string, firstPage: boolean) {
    if (firstPage) query = key;
    const ticket = firstPage ? gate.restart() : gate.follow();
    if (ticket === null) return "skipped";
    shown.error = null;
    const request = deferred<Page>();
    pending.set(key, request);
    requestedFor.set(key, query);
    try {
      const page = await request.promise;
      if (!gate.isCurrent(ticket)) return "dropped";
      shown.rows = firstPage ? page.rows : [...shown.rows, ...page.rows];
      shown.hasMore = page.hasMore;
      if (firstPage) gate.land(ticket);
      return "applied";
    } catch (error) {
      if (!gate.isCurrent(ticket)) return "dropped";
      shown.error = error instanceof Error ? error.message : String(error);
      // The rows on screen are the previous list's: there is no next page of them to offer.
      if (firstPage) shown.hasMore = false;
      return "failed";
    }
  }
  /** The query is read when the request is made (the component's queryRef), not when the refresh was scheduled. */
  async function reloadCounts(key: string) {
    const ticket = gate.follow();
    if (ticket === null) return "skipped";
    const request = deferred<Page>();
    pending.set(key, request);
    requestedFor.set(key, query);
    const { rows: [counts] } = await request.promise;
    if (!gate.isCurrent(ticket)) return "dropped";
    shown.counts = counts ?? null;
    return "applied";
  }
  /** onMutated: the count refresh runs a moment later, from the closure of the render that scheduled it. */
  function scheduleCounts(key: string) {
    return () => reloadCounts(key);
  }
  return {
    shown,
    requestedFor,
    load,
    reloadCounts,
    scheduleCounts,
    answer: (key: string, rows: string[], hasMore = true) => pending.get(key)!.resolve({ rows, hasMore }),
    fail: (key: string) => pending.get(key)!.reject(new Error("The server could not be reached")),
  };
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

  test("an edit's count refresh that runs after another view landed counts that view, not the one the edit was made in", async () => {
    const view = list();
    const first = view.load("all", true);
    view.answer("all", ["a1"]);
    await first;
    const fire = view.scheduleCounts("counts");
    // The Errors tile, picked within the moment before the refresh runs.
    const errors = view.load("errors", true);
    view.answer("errors", ["e1"]);
    await errors;
    const counts = fire();
    expect(view.requestedFor.get("counts")).toBe("errors");
    view.answer("counts", ["errors:1"]);
    expect(await counts).toBe("applied");
    expect(view.shown.counts).toBe("errors:1");
  });

  test("a failed first page offers no Load more that would do nothing; Retry restores the list and its next pages", async () => {
    const view = list();
    const first = view.load("all", true);
    view.answer("all", ["a1"], true);
    await first;
    const errors = view.load("errors", true);
    view.fail("errors");
    expect(await errors).toBe("failed");
    expect(view.shown.error).not.toBeNull();
    expect(view.shown.hasMore).toBe(false);
    expect(await view.load("errors-2", false)).toBe("skipped");
    const retry = view.load("errors", true);
    view.answer("errors", ["e1"], true);
    expect(await retry).toBe("applied");
    expect(view.shown).toMatchObject({ rows: ["e1"], hasMore: true, error: null });
    const more = view.load("errors-2", false);
    view.answer("errors-2", ["e2"], false);
    expect(await more).toBe("applied");
    expect(view.shown).toMatchObject({ rows: ["e1", "e2"], hasMore: false });
  });
});
