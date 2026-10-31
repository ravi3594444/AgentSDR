/** Scoped, disposable database fixture: actual aggregation and request projection, no model or provider. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/auth/schema";
import { people } from "@/lib/leads/schema";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { createAudience } from "@/lib/assistant/audiences.server";
import { assistantThreads, assistantMessages, assistantObjectives, leadAudiences, leadAudienceMembers } from "@/lib/assistant/schema";
import { audienceFunnel, audienceResearchFacts } from "@/lib/assistant/qualify.server";
import { objectiveForRequest, objectiveView } from "@/lib/assistant/objective.server";
import { reviewLeadsText } from "@/lib/assistant/agentV2.server";
import { requestSummary } from "@/lib/assistant/requests.server";
import { ASSISTANT_CHECKED, requestCheck } from "@/lib/assistant/leadFit";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires the disposable local agentsdr_native database");
let checks = 0;
const check = (label: string, ok: unknown) => { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); };
const ids = [randomUUID(), randomUUID()];
let lists: string[] = [];
let requestId = "";
try {
  await db.insert(organizations).values(ids.map((id, i) => ({ id, name: `Progress check ${i}`, slug: `progress-${id}`, createdAt: new Date() })));
  await runInOrganization(ids[0]!, async () => {
    const [thread] = await db.insert(assistantThreads).values({ organizationId: ids[0]!, title: "Progress fixture" }).returning();
    const [request] = await db.insert(assistantMessages).values({ organizationId: ids[0]!, threadId: thread!.id, role: "user", content: "Find potential clients; research only" }).returning();
    requestId = request!.id;
    await db.insert(assistantObjectives).values({ organizationId: ids[0]!, threadId: thread!.id, requestMessageId: requestId, leadTarget: 50, timeLimitMinutes: 60, deadlineAt: new Date(Date.now() + 3_600_000) });
    lists = await Promise.all(["First source", "Second source"].map((name) => createAudience({ name, source: "discovery", criteria: { requestId } })));
    const saved = await db.insert(people).values(Array.from({ length: 6 }, (_, i) => ({ organizationId: ids[0]!, source: "progress-fixture", fullName: `Business ${i}`, email: `business-${i}-${ids[0]}@fixture.test` }))).returning();
    const fits = [null, "unconfirmed", "unconfirmed", "match", "no_match", "match"] as const;
    const rows = saved.map((person, i) => ({ organizationId: ids[0]!, audienceId: lists[0]!, personId: person.id, name: person.fullName!, status: "eligible" as const, channels: ["email" as const], source: "web_search", facts: { postedAt: new Date(Date.now() - 48 * 86_400_000).toISOString(), retrievedAt: new Date().toISOString() }, fit: fits[i]!, fitReason: i === 2 || i === 3 ? `${ASSISTANT_CHECKED}Source evidence checked` : null, fitAt: i === 0 ? null : new Date() }));
    const duplicate = { ...rows[5]!, audienceId: lists[1]!, fit: "no_match" as const, fitReason: "Another source shows this is outside the request" };
    await db.insert(leadAudienceMembers).values([...rows, duplicate, { organizationId: ids[0]!, audienceId: lists[0]!, name: "Unsaved candidate", status: "excluded", channels: [], source: "web_search" }]);
    const facts = await audienceResearchFacts(lists);
    check("actual SQL matches the request's existing checked-person rule", JSON.stringify(facts.review) === JSON.stringify(requestCheck([...rows, duplicate])));
    check("duplicate sources count a saved person only once", facts.review.leads === 6 && facts.funnel.found === 7);
    check("a no-match on either source wins over a thinner match", facts.review.match === 1 && facts.review.noMatch === 2 && facts.funnel.qualified === 1);
    check("unconfirmed without inspection and pending both remain unchecked", facts.review.unconfirmed === 2 && facts.review.pending === 1 && facts.review.unchecked === 2);
    check("a nullable fit remains pending in the existing contact funnel", facts.funnel.pending === 1);
    check("the old funnel API retains the same shape and counts", JSON.stringify(await audienceFunnel(lists)) === JSON.stringify(facts.funnel));
    const view = await objectiveView(requestId);
    check("the browser request exposes the same review facts to the chat", JSON.stringify(view?.review) === JSON.stringify(facts.review) && view?.leadTarget === 50);
    const objective = await objectiveForRequest(requestId);
    const review = await reviewLeadsText({ objective: objective!, audienceId: null, filter: "all", limit: 20 });
    check("the assistant sees old publication age even when the page was read today", review.text.includes("postAgeDays: 48"));
    const [follow] = await db.insert(assistantMessages).values({ organizationId: ids[0]!, threadId: thread!.id, role: "user", content: "Contact those leads" }).returning();
    await db.insert(assistantObjectives).values({ organizationId: ids[0]!, threadId: thread!.id, requestMessageId: follow!.id, controls: { continues: requestId }, leadTarget: 10, timeLimitMinutes: 60, deadlineAt: new Date(Date.now() + 3_600_000) });
    const inherited = await requestSummary(`r:${follow!.id}`);
    check("a contact follow-up keeps matching on the same scope as found and contactable", inherited?.numbers.found === 7 && inherited.numbers.contactable === 6 && inherited.numbers.matching === 1);
    check("inherited matches do not count as newly found leads toward a follow-up target", inherited?.objective?.leads === 0 && inherited.objective.remaining === 10);
    const ownList = await createAudience({ name: "A new source", source: "discovery", criteria: { requestId: follow!.id } });
    const [extra] = await db.insert(people).values({ organizationId: ids[0]!, source: "progress-fixture", fullName: "New business", email: `new-${ids[0]}@fixture.test` }).returning();
    await db.insert(leadAudienceMembers).values({ organizationId: ids[0]!, audienceId: ownList, personId: extra!.id, name: extra!.fullName!, status: "eligible", channels: ["email"], source: "web_search", fit: "match", fitReason: `${ASSISTANT_CHECKED}Checked against the request`, fitAt: new Date() });
    const more = await requestSummary(`r:${follow!.id}`);
    check("new and inherited matches display together while target progress stays separate", more?.numbers.matching === 2 && more.objective?.leads === 1 && more.objective.remaining === 9);
  });
  await runInOrganization(ids[1]!, async () => {
    const foreign = await audienceResearchFacts(lists);
    check("another organization cannot read the first one's review counts", foreign.review.leads === 0 && foreign.funnel.found === 0);
    check("another organization cannot read the research objective", await objectiveView(requestId) === null);
  });
  console.log(`Research progress database checks: ${checks} passed. Disposable data; no outgoing actions.`);
} finally {
  for (const id of ids) await runInOrganization(id, async () => {
    await db.delete(assistantObjectives).where(inOrg(assistantObjectives));
    await db.delete(leadAudienceMembers).where(inOrg(leadAudienceMembers));
    await db.delete(leadAudiences).where(inOrg(leadAudiences));
    await db.delete(assistantMessages).where(inOrg(assistantMessages));
    await db.delete(assistantThreads).where(inOrg(assistantThreads));
    await db.delete(people).where(inOrg(people));
    await db.delete(organizations).where(eq(organizations.id, id));
  });
}
