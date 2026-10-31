/**
 * Settings → Your business (navigation rework N3), end to end on the local
 * database with the real profile, Knowledge and settings functions:
 *
 * - a PATCH (the route's saveBusinessProfileSettings) updates the profile and
 *   its Knowledge copy together, and reports what changed;
 * - emptying a field empties it in both; emptying them all leaves the copy
 *   saying so (archived, out of drafts), never the old text;
 * - a member's PATCH is refused by the same permission check the route uses,
 *   and bad values are refused before anything is saved;
 * - the Knowledge page lists the copy as the profile's, and an edit or
 *   archive of it is refused with a 409 that says where to edit it;
 * - the chat's save_business_info still writes the same row and copy;
 * - the general Sending rules saved from one settings page keep what the
 *   other page stored;
 * - a second organization sees, changes and finds nothing of the first.
 *
 *   bun run --conditions=react-server scripts/e2e/business-profile.ts
 *
 * Creates its own organizations ("Business profile check …") and leaves them.
 * Refuses a non-local DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const stamp = Date.now();
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { assistantProfiles } = await import("@/lib/assistant/schema");
const { businessProfileSettings, saveBusinessProfileSettings, BusinessProfileInputError } = await import("@/lib/assistant/profileSettings.server");
const { getBusinessProfile } = await import("@/lib/assistant/profile.server");
const { EMPTY_PROFILE_KNOWLEDGE_TEXT, PROFILE_DOCUMENT_READ_ONLY } = await import("@/lib/assistant/profile");
const { getKnowledgeDocument, listKnowledgeDocuments, updateKnowledgeDocument } = await import("@/lib/crm/knowledge-service");
const { crmConfigurationErrorResponse } = await import("@/lib/crm/categories");
const { runTool } = await import("@/lib/assistant/tools.server");
const { createThread } = await import("@/lib/assistant/threads.server");
const { isAuthContextError } = await import("@/lib/auth/context");
const { channelRulesForSettings, saveChannelRules } = await import("@/lib/channels/rules.server");
const { GENERAL_RULE_PAGES, ruleSubmission, rulesSubset } = await import("@/lib/channels/rules");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function refusal(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return null;
  } catch (error) {
    return error;
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const [a] = await db.insert(organizations).values({ name: `Business profile check A ${stamp}`, slug: `business-profile-check-a-${stamp}` }).returning();
const [b] = await db.insert(organizations).values({ name: `Business profile check B ${stamp}`, slug: `business-profile-check-b-${stamp}` }).returning();
const owner = { roles: ["owner" as const], userId: randomUUID() };
const admin = { roles: ["admin" as const], userId: randomUUID() };
const member = { roles: ["member" as const], userId: randomUUID() };

/** The copy's latest text, whether it is active and whether drafts always get it. */
async function copyOf(documentId: string | null) {
  if (!documentId) return null;
  const document = await getKnowledgeDocument(documentId);
  const latest = document.versions.at(-1);
  return { text: latest?.content ?? "", active: document.active, alwaysInclude: document.alwaysInclude, versions: document.versions.length, title: document.title };
}

const ids = await runInOrganization(a!.id, async () => {
  const fresh = await businessProfileSettings(owner);
  check("a new organization starts with an empty profile and no Knowledge copy", Object.keys(fresh.profile).length === 0 && fresh.knowledgeDocumentId === null && fresh.canEdit);
  check("a member may read it but not edit it", (await businessProfileSettings(member)).canEdit === false);

  // ------------------------------------------------------------ PATCH updates both
  const saved = await saveBusinessProfileSettings(owner, {
    businessName: "Bright Path Dental Supplies",
    offer: "Same-week servicing of dental chairs and autoclaves",
    prices: "Chair service from 2,499 INR",
    locations: "Pune",
    preferredChannels: ["whatsapp", "email"],
    language: "EN",
  });
  check("a PATCH saves the profile and reports each changed field", saved.profile.businessName === "Bright Path Dental Supplies" && saved.profile.language === "en" && JSON.stringify(saved.profileChanges.sort()) === JSON.stringify(["businessName", "language", "locations", "offer", "preferredChannels", "prices"]), saved.profileChanges.join(","));
  const documentId = saved.knowledgeDocumentId;
  const copy = await copyOf(documentId);
  check("…and writes its Knowledge copy in the same save", Boolean(copy?.text.includes("Business: Bright Path Dental Supplies") && copy.text.includes("Prices: Chair service from 2,499 INR") && copy.text.includes("Preferred channels: whatsapp, email")), JSON.stringify(copy?.text).slice(0, 160));
  check("…an active copy every draft includes, titled Business profile", copy?.active === true && copy.alwaysInclude === true && copy.title === "Business profile");

  const again = await saveBusinessProfileSettings(admin, { offer: "Same-week servicing of dental chairs and autoclaves" });
  check("an admin may save; a save that changes nothing writes nothing", again.profileChanges.length === 0 && (await copyOf(documentId))?.versions === copy?.versions);

  // ------------------------------------------------------------ emptying a field
  const cleared = await saveBusinessProfileSettings(owner, { prices: "", senderName: "Ravi" });
  const afterClear = await copyOf(documentId);
  check("emptying a field removes it from the profile", cleared.profile.prices === undefined && cleared.profile.senderName === "Ravi" && JSON.stringify(cleared.profileChanges.sort()) === JSON.stringify(["prices", "senderName"]));
  check("…and from its Knowledge copy, in the same document", cleared.knowledgeDocumentId === documentId && !afterClear?.text.includes("Prices") && Boolean(afterClear?.text.includes("Sender name: Ravi")), JSON.stringify(afterClear?.text).slice(0, 160));

  // ------------------------------------------------------------ refusals
  const denied = await refusal(() => saveBusinessProfileSettings(member, { offer: "Something else" }));
  check("a member's PATCH is refused with the route's 403", isAuthContextError(denied) && denied.status === 403, message(denied));
  const bad = await refusal(() => saveBusinessProfileSettings(owner, { offer: 5, language: "English", favouriteColour: "blue" }));
  check("bad values are refused, each named, before anything is saved", bad instanceof BusinessProfileInputError && bad.problems.length === 3 && (await getBusinessProfile()).offer === "Same-week servicing of dental chairs and autoclaves", message(bad));
  check("…and so is a field longer than the limit, rather than cut", (await refusal(() => saveBusinessProfileSettings(owner, { notes: "x".repeat(4_001) }))) instanceof BusinessProfileInputError);

  // ------------------------------------------------------------ the Knowledge page
  const listed = await listKnowledgeDocuments({ includeArchived: true });
  check("the Knowledge list marks the copy as the profile's, and only it", listed.filter((document) => document.businessProfile).map((document) => document.id).join() === documentId);
  for (const [label, edit] of [["an edit of the copy's text", { content: "Hand-edited" }], ["archiving the copy", { active: false }], ["renaming the copy", { title: "Mine now" }]] as const) {
    const error = await refusal(() => updateKnowledgeDocument(documentId!, edit));
    const response = crmConfigurationErrorResponse(error);
    const body = (await response.json()) as { error?: string };
    check(`Knowledge refuses ${label}: 409, saying where to edit it`, response.status === 409 && body.error === PROFILE_DOCUMENT_READ_ONLY && /Settings → Your business/.test(body.error ?? ""), `${response.status} ${body.error}`);
  }
  check("…and the copy is unchanged", (await copyOf(documentId))?.versions === afterClear?.versions);

  // ------------------------------------------------------------ the chat's tool, same row
  const thread = await createThread(null);
  const chat = await runTool("save_business_info", { targetCustomers: "independent dental clinics", senderRole: "Founder" }, { threadId: thread.id, userId: owner.userId, ownerText: "We serve independent dental clinics. I'm the founder." });
  const [row] = await db.select().from(assistantProfiles).where(eq(assistantProfiles.organizationId, a!.id));
  const chatCopy = await copyOf(documentId);
  check("save_business_info still saves to the same profile row", chat.ok && row?.profile.targetCustomers === "independent dental clinics" && row.profile.businessName === "Bright Path Dental Supplies", chat.summary);
  check("…and rewrites the same Knowledge copy", row?.knowledgeDocumentId === documentId && Boolean(chatCopy?.text.includes("Target customers: independent dental clinics")) && chatCopy?.active === true);
  check("Settings reads what the chat saved", (await businessProfileSettings(member)).profile.senderRole === "Founder");

  // ------------------------------------------------------------ emptying everything
  const everything = Object.fromEntries(Object.keys(row!.profile).map((key) => [key, key === "preferredChannels" ? [] : ""]));
  const emptied = await saveBusinessProfileSettings(owner, everything);
  const emptyCopy = await copyOf(documentId);
  check("clearing every field empties the profile", Object.keys(emptied.profile).filter((key) => key !== "preferredChannels").length === 0 && (emptied.profile.preferredChannels ?? []).length === 0, JSON.stringify(emptied.profile));
  check("…and the copy says so instead of keeping the old text", emptyCopy?.text === EMPTY_PROFILE_KNOWLEDGE_TEXT && !emptyCopy.text.includes("Bright Path"), emptyCopy?.text);
  check("…archived and out of every draft", emptyCopy?.active === false && emptyCopy.alwaysInclude === false);
  const refilled = await saveBusinessProfileSettings(owner, { businessName: "Bright Path" });
  const refilledCopy = await copyOf(documentId);
  check("filling it again brings the same copy back into drafts", refilled.knowledgeDocumentId === documentId && refilledCopy?.active === true && refilledCopy.alwaysInclude === true && refilledCopy.text === "Business: Bright Path");

  // ------------------------------------------------------------ the general rules across pages
  await saveChannelRules("general", { objectiveLeadTarget: 80, newLeadsPerDay: 20 }, owner.userId);
  const businessPage = rulesSubset("general", GENERAL_RULE_PAGES.business);
  const shown = (await channelRulesForSettings("general")).values;
  await saveChannelRules("general", ruleSubmission(businessPage, { ...shown, timeZone: "Asia/Kolkata", objectiveLeadTarget: 25, newLeadsPerDay: 50 }), owner.userId);
  const after = (await channelRulesForSettings("general")).values;
  check("saving the day on Your business keeps the research target and the daily lead limit the other pages stored", after.timeZone === "Asia/Kolkata" && after.objectiveLeadTarget === 80 && after.newLeadsPerDay === 20, JSON.stringify({ timeZone: after.timeZone, objectiveLeadTarget: after.objectiveLeadTarget, newLeadsPerDay: after.newLeadsPerDay }));

  return { documentId: documentId! };
});

await runInOrganization(b!.id, async () => {
  const view = await businessProfileSettings(owner);
  check("another organization sees an empty profile and no copy", Object.keys(view.profile).length === 0 && view.knowledgeDocumentId === null);
  check("…lists none of the first one's Knowledge", (await listKnowledgeDocuments({ includeArchived: true })).length === 0);
  check("…cannot open the first one's copy", Boolean(await refusal(() => getKnowledgeDocument(ids.documentId))));
  check("…nor edit it", Boolean(await refusal(() => updateKnowledgeDocument(ids.documentId, { content: "Taken over" }))));
  const own = await saveBusinessProfileSettings(owner, { businessName: "Other Co" });
  check("…and saving its own profile makes its own copy", Boolean(own.knowledgeDocumentId) && own.knowledgeDocumentId !== ids.documentId);
  check("…while its general rules stay its own", (await channelRulesForSettings("general")).values.objectiveLeadTarget === 200);
});

await runInOrganization(a!.id, async () => {
  const view = await businessProfileSettings(owner);
  const copy = await copyOf(ids.documentId);
  check("the first organization's profile and copy are untouched by the second", view.profile.businessName === "Bright Path" && copy?.text === "Business: Bright Path");
});

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("Business profile checks passed");
process.exit(0);
