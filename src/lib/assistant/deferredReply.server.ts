import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enqueueCrmJobInTransaction } from "@/lib/crm/queue";
import { CrmConflictError } from "@/lib/crm/repository";
import { inOrg } from "@/lib/tenancy/scope";
import { autopilotReplies } from "./schema";

export const SENDER_GAP_WAIT = "Waiting for the sender's gap between messages; this reply is queued";

/** Release only a definitely unsubmitted reservation. The send job rechecks mode, DNC, context and limits. */
export async function deferReplySend(input: {
  reservationId: string;
  draftId: string;
  revision: number;
  readyAt: Date;
  retryAt: Date;
  idempotencyKey?: string;
  /** An auto_send job already owns its row and will reschedule itself through RetryCrmJobLaterError. */
  jobAlreadyRunning?: boolean;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const held = await tx.update(autopilotReplies)
      .set({ status: "held", reason: SENDER_GAP_WAIT, updatedAt: new Date() })
      .where(and(inOrg(autopilotReplies), eq(autopilotReplies.id, input.reservationId), eq(autopilotReplies.status, "reserved")))
      .returning({ id: autopilotReplies.id });
    if (!held.length) throw new CrmConflictError("The automatic reply's reservation changed while it was waiting");
    if (!input.jobAlreadyRunning) {
      await enqueueCrmJobInTransaction(tx, {
        kind: "auto_send", entityId: input.draftId,
        payload: { revision: input.revision, readyAt: input.readyAt.toISOString(), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
        runAfter: input.retryAt, requeueCompleted: true, maxAttempts: 3,
      });
    }
  });
}
