import type { NextRequest } from "next/server";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseRequiredText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { closeCrmRecord, markCrmRecordReviewed, reopenCrmRecord } from "@/lib/crm/operations";
import { pauseSequence, resumeSequence, skipCurrentSequenceStep, snoozeSequence } from "@/lib/crm/sequences";
import { runInOrganization } from "@/lib/tenancy/scope";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const { id: rawId, action } = await params;
      const recordId = parseUuid(rawId, "record id");
      if (action === "pause") return Response.json({ result: await pauseSequence({ recordId }) });
      if (action === "resume") return Response.json({ result: await resumeSequence({ recordId }) });
      if (action === "skip") return Response.json({ result: await skipCurrentSequenceStep({ recordId }) });
      if (action === "reopen") return Response.json({ record: await reopenCrmRecord({ recordId }) });
      if (action === "reviewed") return Response.json({ record: await markCrmRecordReviewed({ recordId }) });
      const value = await readCrmJson(request);
      assertObject(value);
      if (action === "snooze") {
        assertExactKeys(value, ["until"]);
        if (typeof value.until !== "string") throw new Error("until must be an ISO timestamp");
        return Response.json({ record: await snoozeSequence({ recordId, until: new Date(value.until) }) });
      }
      if (action === "close") {
        assertExactKeys(value, ["reason"]);
        return Response.json({ record: await closeCrmRecord({
          recordId,
          reason: value.reason === undefined ? "Closed by operator" : parseRequiredText(value.reason, "reason", 2_000),
        }) });
      }
      return Response.json({ error: "Unknown CRM record action", code: "NOT_FOUND" }, { status: 404 });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
