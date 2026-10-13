import { NextRequest, NextResponse } from "next/server";
import { importLeadsForCampaign, spreadsheetPreview, suggestedEmailMapping, type EmailCsvMapping } from "@/lib/outreach/leadImport";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";
import { SpreadsheetReadError } from "@/lib/spreadsheet/read";

// POST /api/outreach/campaigns/[id]/leads/import — multipart form upload, field name "file".
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: "file is required" }, { status: 400 });
      }

      const buffer = await file.arrayBuffer();
      if (form?.get("mode") === "preview") {
        let preview: ReturnType<typeof spreadsheetPreview>;
        try {
          preview = spreadsheetPreview(buffer);
        } catch (error) {
          if (error instanceof SpreadsheetReadError) return NextResponse.json({ error: error.message }, { status: 400 });
          throw error;
        }
        return NextResponse.json({ ...preview, suggestedMapping: suggestedEmailMapping(preview.headers) });
      }
      let mapping: EmailCsvMapping | undefined;
      const rawMapping = form?.get("mapping");
      if (typeof rawMapping === "string") {
        try { mapping = JSON.parse(rawMapping) as EmailCsvMapping; }
        catch { return NextResponse.json({ error: "mapping must be valid JSON" }, { status: 400 }); }
      }
      if (!mapping) return NextResponse.json({ error: "Confirm the CSV column mapping before importing" }, { status: 400 });
      const result = await importLeadsForCampaign(id, buffer, { filename: file.name, mapping });
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: result.error === "Campaign not found" ? 404 : 400 });
      }
      return NextResponse.json(result);
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
