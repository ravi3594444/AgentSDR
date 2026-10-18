/**
 * Keeps a paged list's answers in the order its requests were made. Each
 * first-page request (a new view, filter or refresh) starts a new list; an
 * answer to a request made for an earlier list is stale when it returns and is
 * dropped, so a slow response never replaces the list a newer request asked
 * for. Next pages and count refreshes follow the shown list, and wait until
 * the newest list's first page has landed (until then the offset and counts
 * on screen belong to the list being replaced).
 */
export function createResponseGate() {
  let generation = 0;
  let landed = true;
  return {
    /** A first-page request: whatever is still in flight becomes stale. */
    restart(): number {
      generation += 1;
      landed = false;
      return generation;
    },
    /** A request that continues the shown list, or null while a new list's first page is loading. */
    follow(): number | null {
      return landed ? generation : null;
    },
    /** Whether an answer may be applied: only one made for the newest list. */
    isCurrent(ticket: number): boolean {
      return ticket === generation;
    },
    /** The newest list's first page was applied, so its next pages may follow. */
    land(ticket: number): void {
      if (ticket === generation) landed = true;
    },
  };
}

export type ResponseGate = ReturnType<typeof createResponseGate>;
