import { NextRequest, NextResponse } from "next/server";
import { upsertManualPerson } from "@/lib/leads/manualImport";
import { parseImportRows, type ImportRow } from "@/lib/leads/importRows";
import { planPeopleImport } from "@/lib/leads/peopleImport";
import { importPhoneOnlyPerson } from "@/lib/leads/peopleImport.server";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
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
  const plan = planPeopleImport(rows, await organizationPhoneCountry());
  const total = plan.identified.length + plan.phoneOnly.length;
  if (!total && !plan.failed.length) {
    return NextResponse.json({ error: "No rows with an Email, LinkedIn URL or phone number were found" }, { status: 400 });
  }
  if (total > MAX_ROWS) return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS})` }, { status: 400 });

  let created = 0;
  let updated = 0;
  const failed = [...plan.failed];
  for (const row of plan.identified) {
    try {
      const result = await upsertManualPerson(row);
      if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      failed.push({ row: row.rowNumber, identity: row.email ?? row.linkedinUrl ?? "unknown", error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const { row, phone } of plan.phoneOnly) {
    try {
      const result = await importPhoneOnlyPerson(row, phone);
      if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      failed.push({ row: row.rowNumber, identity: phone, error: error instanceof Error ? error.message : String(error) });
    }
  }
  failed.sort((a, b) => a.row - b.row);
  return NextResponse.json({
    total: total + plan.failed.length,
    created,
    updated,
    phoneOnly: plan.phoneOnly.length,
    failed,
    warnings: plan.warnings,
    skippedNoIdentity: plan.skippedNoIdentity,
  });
}
