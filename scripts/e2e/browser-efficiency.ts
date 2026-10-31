/** Disposable DB: phone-recipient checks and bridge diagnostics. No sends or providers. */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/auth/schema";
import { people } from "@/lib/leads/schema";
import { crmPersonContactPolicies } from "@/lib/crm/schema";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { recipientRef } from "@/lib/browserOutreach/routes";
import { recipientDoNotContact } from "@/lib/browserOutreach/recipients.server";
import { parseResultRequest } from "@/lib/browser/connected/connections.server";
import { coerceToolArguments, TOOL_SCHEMAS } from "@/lib/assistant/toolSchemas";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable local agentsdr_native database");
let checks = 0;
const check = (label: string, ok: unknown) => { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); };
const stamp = randomUUID();
const ids = [randomUUID(), randomUUID()];
try {
  await db.insert(organizations).values(ids.map((id, i) => ({ id, name: `Browser efficiency ${i}`, slug: `browser-efficiency-${i}-${stamp}`, createdAt: new Date() })));
  const rows = await db.insert(people).values([
    { organizationId: ids[0]!, source: "efficiency-fixture", fullName: "Unblocked duplicate", phone: "+1 (202) 555-0101" },
    { organizationId: ids[0]!, source: "efficiency-fixture", fullName: "Opted out duplicate", phone: "+12025550101" },
    { organizationId: ids[1]!, source: "efficiency-fixture", fullName: "Other workspace", phone: "+12025550102" },
  ]).returning();
  await db.insert(crmPersonContactPolicies).values([{ personId: rows[1]!.id, doNotContact: true, source: "human", setAt: new Date() }, { personId: rows[2]!.id, doNotContact: true, source: "human", setAt: new Date() }]);
  await runInOrganization(ids[0]!, async () => {
    check("a phone recipient matches the saved opt-out despite formatting", await recipientDoNotContact(recipientRef("+1 202 555 0101")));
    check("an unblocked duplicate cannot hide another matching person's opt-out", await recipientDoNotContact(recipientRef("0012025550101")));
    check("another workspace's phone opt-out is not read or applied", !await recipientDoNotContact(recipientRef("+12025550102")));
  });
  await runInOrganization(ids[1]!, async () => {
    check("the second workspace cannot read the first workspace's policy", !await recipientDoNotContact(recipientRef("+12025550101")));
    check("the second workspace can read its own policy", await recipientDoNotContact(recipientRef("+12025550102")));
  });
  const diagnostics = parseResultRequest({ seq: 1, result: { ok: true, timing: { browserMs: 120, readyWaitMs: 80, queueMs: -1, roundTripMs: Infinity, execute: "send" }, readiness: { state: "timeout", waitedMs: 80, checks: 3 } } }).result;
  check("bridge diagnostics keep valid timings and an honest timeout", diagnostics.timing?.browserMs === 120 && diagnostics.timing.readyWaitMs === 80 && diagnostics.readiness?.state === "timeout");
  check("invalid or action-like diagnostic fields are dropped", diagnostics.timing?.queueMs === undefined && diagnostics.timing?.roundTripMs === undefined && !("execute" in (diagnostics.timing ?? {})));
  const failed = parseResultRequest({ seq: 1, result: { ok: false, error: "Stop", readiness: { state: "cancelled", waitedMs: 5, checks: 1 }, timing: { browserMs: 6 } } }).result;
  check("cancelled commands retain their diagnostic evidence", !failed.ok && failed.readiness?.state === "cancelled" && failed.timing?.browserMs === 6);
  const parsed = coerceToolArguments(TOOL_SCHEMAS.browser_tab_open!, { url: "https://fixture.net", reuse: "false", waitFor: { selector: "footer", timeoutMs: "500" } });
  check("native MCP inputs coerce nested timeouts and booleans by the typed schema", parsed.problems.length === 0 && parsed.args.reuse === false && (parsed.args.waitFor as { timeoutMs: number }).timeoutMs === 500);
  console.log(`Browser efficiency DB/contract checks: ${checks} passed. Disposable data only.`);
} finally {
  for (const id of ids) await runInOrganization(id, async () => {
    await db.delete(crmPersonContactPolicies).where(inArray(crmPersonContactPolicies.personId, db.select({ id: people.id }).from(people).where(inOrg(people))));
    await db.delete(people).where(inOrg(people));
    await db.delete(organizations).where(eq(organizations.id, id));
  });
}
