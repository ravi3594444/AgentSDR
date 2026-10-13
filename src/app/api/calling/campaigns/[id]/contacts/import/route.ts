import type { NextRequest } from "next/server";
import { CrmConfigurationValidationError } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { callApiErrorResponse, importCampaignContacts } from "@/lib/calls/campaigns";
import { runInOrganization } from "@/lib/tenancy/scope";
import { spreadsheetUploadProblem, UNREADABLE_UPLOAD_MESSAGE } from "@/lib/spreadsheet/upload";

/**
 * Multipart `file` upload (CSV or XLSX) — same parsing and header aliasing
 * as the People import (src/app/api/leads/people/import/route.ts), shared
 * through src/lib/leads/importRows.ts. Only a valid phone number is required
 * for a row to be added here; see campaigns.ts's resolveImportRow.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    const campaignId = (await params).id;
    const form = await request.formData().catch(() => null);
    if (!form) throw new CrmConfigurationValidationError(UNREADABLE_UPLOAD_MESSAGE);
    const file = form.get("file");
    if (!(file instanceof File)) throw new CrmConfigurationValidationError("file is required");
    const problem = spreadsheetUploadProblem(file);
    if (problem) throw new CrmConfigurationValidationError(problem);
    const buffer = await file.arrayBuffer();
    return await runInOrganization(ctx.organizationId, async () => Response.json(await importCampaignContacts(campaignId, buffer)));
  } catch (error) {
    return callApiErrorResponse(error);
  }
}
