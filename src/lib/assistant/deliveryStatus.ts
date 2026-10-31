/** Shared instructions for status questions in either assistant harness. */
export const DELIVERY_STATUS_GUIDANCE = [
  "DELIVERY AND REPLY QUESTIONS: a status question is not a new lead request. Use diagnose_delivery with the specific runId once. Its latest incoming message previews and processing outcomes are the evidence for whether that reply was answered; an empty campaign queue and historical reply totals cannot establish this.",
  "Connection states belong to exact accounts and conversations, not display names: older disconnected accounts can have the same number as the current connected account. Use the newest plan-scoped check. Never tell the owner to reconnect because a different account was disconnected in an earlier organization-wide snapshot.",
  "Read the reply text and its recorded outcome returned by the tool. Do not say you cannot see it or ask the owner to retype a message that is in the tool result. If no new incoming reply was recorded since Start, say that; do not infer its contents or promise it was answered. Stored state is not a live provider connection check.",
  "A timeout leaves the operation's outcome unknown; it does not prove failure. Before repeating plan preparation or reporting that no plan exists or nothing was sent, read list_runs and the specific plan's diagnose_delivery. Reuse the saved plan. If that read also fails, report the outcome as unconfirmed and do not promise to recreate the plan.",
  "Give one short answer with what is recorded, what is blocked or unknown, and the next useful action. Do not repeat report, list_runs or diagnose_delivery just to keep saying you are checking. Do not promise a later check unless an actual background job was scheduled. Detailed figures are already on the cards.",
].join("\n");

const UNCERTAIN = /\b(?:timed? out|timeout|(?:do not|don't|cannot|can't|could not|couldn't) (?:know|confirm|tell|see)|not sure)\b/i;
const PLAN_UNKNOWN = /\b(?:do not know|don't know|cannot confirm|can't confirm|could not confirm|couldn't confirm|not sure)\b[^.!?\n]{0,100}\b(?:plan|outreach)\b[^.!?\n]{0,45}\b(?:exists?|created|prepared|started|running|went through)\b|\bno (?:outreach )?plan (?:exists|was created|has been created)\b/i;
const NOTHING_SENT = /\b(?:nothing|no (?:messages?|emails?|outreach))\b[^.!?\n]{0,65}\b(?:sent|contacted)\b|\bnothing is confirmed as sent\b/i;

/** Only ambiguous/negative outcome claims need another read; normal answers add no status query. */
export function needsOutreachReconciliation(message: string): boolean {
  message = message.replace(/[’‘]/g, "'");
  return /\b(?:plan|outreach|campaign|sent|contacted)\b/i.test(message)
    && (UNCERTAIN.test(message) || PLAN_UNKNOWN.test(message) || NOTHING_SENT.test(message));
}

/** A lost tool answer must not override committed plan/send evidence. Provider delivery remains separate. */
export function savedOutreachProblem(message: string, saved: { plans: readonly { id: string; state: string }[]; contacted: number; checkedAt: string }): string | null {
  message = message.replace(/[’‘]/g, "'");
  if (!(saved.plans.length && PLAN_UNKNOWN.test(message)) && !(saved.contacted > 0 && NOTHING_SENT.test(message))) return null;
  return `The saved request status checked at ${saved.checkedAt} contradicts the uncertain outcome in your answer: plans ${saved.plans.map((plan) => `${plan.id} (${plan.state})`).join(", ") || "none"}; ${saved.contacted} people recorded contacted. Correct the answer using this saved status; do not recreate the plan or repeat sending because a tool timed out. Contacted does not establish delivery, reading or a reply; diagnose_delivery can inspect the specific plan.`;
}
