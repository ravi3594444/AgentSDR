import { NextRequest, NextResponse } from "next/server";
import { parseImportRows, type ImportRow } from "@/lib/leads/importRows";
import { importPeopleRows } from "@/lib/leads/peopleImport.server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { SPREADSHEET_UPLOAD_MAX_BYTES, spreadsheetUploadProblem, UNREADABLE_UPLOAD_MESSAGE } from "@/lib/spreadsheet/upload";

export const dynamic = "force-dynamic";
const MAX_ROWS = 5000;

// Rows are identified by Email or LinkedIn URL, or, without either, by a
// valid phone number (a phone-only contact for WhatsApp); see
// src/lib/leads/peopleImport.ts. The Calling contacts import shares
// parseImportRows but needs a phone on every row.

export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, () => importPeople(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function importPeople(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: UNREADABLE_UPLOAD_MESSAGE }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  const problem = spreadsheetUploadProblem(file);
  if (problem) return NextResponse.json({ error: problem }, { status: file.size > SPREADSHEET_UPLOAD_MAX_BYTES ? 413 : 400 });
  let rows: ImportRow[];
  try {
    rows = parseImportRows(await file.arrayBuffer());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to parse file" }, { status: 400 });
  }
  const identifiable = rows.filter((row) => row.email || row.linkedinUrl || row.phone).length;
  if (identifiable > MAX_ROWS) return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS})` }, { status: 400 });
  const result = await importPeopleRows(rows);
  if (!result.created && !result.updated && !result.failed.length) {
    return NextResponse.json({ error: "No rows with an Email, LinkedIn URL or phone number were found" }, { status: 400 });
  }
  return NextResponse.json({
    total: result.total,
    created: result.created,
    updated: result.updated,
    phoneOnly: result.phoneOnly,
    failed: result.failed,
    warnings: result.warnings,
    skippedNoIdentity: result.skippedNoIdentity,
  });
}
