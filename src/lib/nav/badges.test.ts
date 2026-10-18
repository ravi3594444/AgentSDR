import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { crmActionQueueCondition } from "@/lib/crm/queries";
import { navBadgesSql } from "./badges.server";

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);
/** The list's condition is written against crm_records' Drizzle columns; the badge's against `r.`. */
const asAlias = (text: string) => text.replace(/"crm_records"\."(\w+)"/g, "r.$1").replace(/\s+/g, " ");

describe("navigation badges", () => {
  test("Action required counts exactly what the Action required list lists", () => {
    const badge = render(navBadgesSql("00000000-0000-0000-0000-00000000000a"));
    const list = asAlias(render(crmActionQueueCondition).sql);
    const actionRequired = asAlias(badge.sql).split(" AS action_required")[0]!;
    expect(actionRequired).toContain(list);
    // Errors and due follow-ups are in the list, so the badge does not stop at the state.
    expect(list).toContain("'error'");
    expect(list).toContain("r.next_action_at <= now()");
    expect(actionRequired).toContain("r.organization_id = $1");
    expect(badge.params[0]).toBe("00000000-0000-0000-0000-00000000000a");
  });

  test("accounts needing attention include disconnected Instagram accounts", () => {
    expect(render(navBadgesSql("org")).sql).toContain("FROM instagram_accounts WHERE organization_id = $");
  });
});
