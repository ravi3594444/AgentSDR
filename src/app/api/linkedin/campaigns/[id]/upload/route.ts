import { NextRequest, NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { readTextRecords, SpreadsheetReadError } from "@/lib/spreadsheet/read";
import { spreadsheetUploadProblem, SPREADSHEET_UPLOAD_MAX_BYTES, UNREADABLE_UPLOAD_MESSAGE } from "@/lib/spreadsheet/upload";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { campaigns } from "@/lib/linkedin/schema";
import { importLeadRows, mapSpreadsheetRowsWithMapping, suggestedLinkedinMapping, type LinkedinCsvMapping } from "@/lib/linkedin/importLeads";
import { buildImportLeadsJsonResponse } from "@/lib/linkedin/importLeadsResponse";
import { serializeError } from "@/lib/linkedin/serializeError";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(req, async () => {
    const { id: campaignId } = await params;

    try {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(and(inOrg(campaigns), eq(campaigns.id, campaignId)))
        .limit(1);
      if (!campaign) {
        return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
      }

      const formData = await req.formData().catch(() => null);
      if (!formData) return NextResponse.json({ ok: false, error: UNREADABLE_UPLOAD_MESSAGE }, { status: 400 });
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
      }
      const problem = spreadsheetUploadProblem(file);
      if (problem) return NextResponse.json({ ok: false, error: problem }, { status: file.size > SPREADSHEET_UPLOAD_MAX_BYTES ? 413 : 400 });

      // Cells as typed text, so a phone or id column keeps its leading zeros.
      let sheet: ReturnType<typeof readTextRecords>;
      try {
        sheet = readTextRecords(await file.arrayBuffer());
      } catch (error) {
        if (error instanceof SpreadsheetReadError) return NextResponse.json({ ok: false, error: error.message === "The worksheet is empty" ? "Empty spreadsheet" : error.message }, { status: 400 });
        throw error;
      }
      const { headers, records: rows } = sheet;

      if (rows.length === 0) {
        return NextResponse.json({ ok: false, error: "Empty spreadsheet" }, { status: 400 });
      }

      if (formData.get("mode") === "preview") {
        return NextResponse.json({ headers, rows: rows.slice(0, 5).map((row) => headers.map((header) => row[header] ?? "")), totalRows: rows.length, suggestedMapping: suggestedLinkedinMapping(headers) });
      }
      const rawMapping = formData.get("mapping");
      if (typeof rawMapping !== "string") {
        return NextResponse.json({ ok: false, error: "Confirm the CSV column mapping before importing" }, { status: 400 });
      }
      let mapping: LinkedinCsvMapping;
      try { mapping = JSON.parse(rawMapping) as LinkedinCsvMapping; }
      catch { return NextResponse.json({ ok: false, error: "mapping must be valid JSON" }, { status: 400 }); }
      if (!mapping.linkedinUrl) return NextResponse.json({ ok: false, error: "Map the required LinkedIn URL column" }, { status: 400 });
      const selectedHeaders = Object.values(mapping).filter((value): value is string => !!value);
      if (new Set(selectedHeaders).size !== selectedHeaders.length) return NextResponse.json({ ok: false, error: "Each CSV column can map to only one destination field" }, { status: 400 });
      if (selectedHeaders.some((header) => !headers.includes(header))) return NextResponse.json({ ok: false, error: "The mapping references a column that is not in this file" }, { status: 400 });

      const result = await importLeadRows(mapSpreadsheetRowsWithMapping(rows, mapping), {
        campaignId,
        attachCampaignToExisting: true,
        filename: file.name,
      });

      return NextResponse.json(buildImportLeadsJsonResponse(result));
    } catch (err) {
      return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
    }
  });
}
