import { createHash } from "node:crypto";
import type { AudienceChannel } from "./schema";

/** A retry's generated list id and the model's paraphrase are not a new plan.
 * Changing recipients, routes or explicit writing instructions is.
 * A new owner request has its own key even for the same people.
 */
export function planPreparationKey(input: {
  requestId: string | null;
  threadId: string | null;
  assignments: { personId: string; channel: AudienceChannel }[];
  autopilot?: boolean;
  instructions?: string | null;
  basedOnRunId?: string | null;
  includeSkipped?: boolean;
  sortLeads?: boolean;
}): string | null {
  if (!input.requestId) return null;
  return createHash("sha256").update(JSON.stringify({
    requestId: input.requestId,
    threadId: input.threadId,
    assignments: [...new Set(input.assignments.map(({ personId, channel }) => `${personId}:${channel}`))].sort(),
    instructions: input.instructions?.trim() || null,
    basedOnRunId: input.basedOnRunId ?? null,
    includeSkipped: Boolean(input.includeSkipped),
    sortLeads: input.sortLeads !== false,
  })).digest("hex");
}
