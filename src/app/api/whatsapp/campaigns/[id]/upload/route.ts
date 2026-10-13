import type { NextRequest } from "next/server";
import { CrmConfigurationValidationError } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { runInOrganization } from "@/lib/tenancy/scope";
import { whatsappApiErrorResponse } from "@/lib/whatsapp/errors";
import { importWhatsappCampaignLeads, previewWhatsappCampaignUpload } from "@/lib/whatsapp/campaigns/campaigns.server";
import { spreadsheetUploadProblem } from "@/lib/spreadsheet/upload";

type Params = { params: Promise<{ id: string }> };

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Multipart: `file`, then either `mode=preview` (headers, first rows, suggested
 * mapping) or `mapping` (JSON, field key → column header) to import.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const ctx = await requireCrmMutationContext(request);
    const { id } = await params;
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new CrmConfigurationValidationError("Send the spreadsheet as multipart form data");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new CrmConfigurationValidationError("No file provided");
    const problem = spreadsheetUploadProblem(file, MAX_FILE_BYTES);
    if (problem) throw new CrmConfigurationValidationError(problem);
    const buffer = await file.arrayBuffer();

    if (form.get("mode") === "preview") {
      return await runInOrganization(ctx.organizationId, async () => Response.json(await previewWhatsappCampaignUpload(id, buffer)));
    }
    const rawMapping = form.get("mapping");
    if (typeof rawMapping !== "string") throw new CrmConfigurationValidationError("Confirm the column mapping before importing");
    let mapping: unknown;
    try {
      mapping = JSON.parse(rawMapping);
    } catch {
      throw new CrmConfigurationValidationError("mapping must be valid JSON");
    }
    return await runInOrganization(ctx.organizationId, async () => Response.json(await importWhatsappCampaignLeads(id, buffer, mapping)));
  } catch (error) {
    return whatsappApiErrorResponse(error);
  }
}
