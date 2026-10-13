import { NextRequest, NextResponse } from "next/server";
import { upsertManualPerson } from "@/lib/leads/manualImport";
import { parseImportRows, type ImportRow } from "@/lib/leads/importRows";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";

export const dynamic = "force-dynamic";
const MAX_ROWS = 5000;

// The People import needs an Email or LinkedIn URL to identify a row; the
// Calling contacts import (src/app/api/calling/campaigns/[id]/contacts/import)
// shares parseImportRows but filters on phone instead — see that module.
function parseRows(buffer: ArrayBuffer): ImportRow[] {
  return parseImportRows(buffer).filter((row) => row.email || row.linkedinUrl);
}

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
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  let rows: ImportRow[];
  try {
    rows = parseRows(await file.arrayBuffer());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to parse file" }, { status: 400 });
  }
  if (!rows.length) return NextResponse.json({ error: "No rows with an Email or LinkedIn URL were found" }, { status: 400 });
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS})` }, { status: 400 });

  let created = 0;
  let updated = 0;
  const failed: Array<{ row: number; identity: string; error: string }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      const result = await upsertManualPerson(row);
      if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      failed.push({
        row: row.rowNumber,
        identity: row.email ?? row.linkedinUrl ?? "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return NextResponse.json({ total: rows.length, created, updated, failed });
}
