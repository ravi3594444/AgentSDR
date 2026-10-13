import { NextRequest, NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { createSearchBatch, parseSearchSheet, startSearchBatchRun } from "@/lib/linkedin/searchBatches";
import { SpreadsheetReadError } from "@/lib/spreadsheet/read";
import { spreadsheetUploadProblem, SPREADSHEET_UPLOAD_MAX_BYTES, UNREADABLE_UPLOAD_MESSAGE } from "@/lib/spreadsheet/upload";

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export async function POST(req: NextRequest) {
  return withLinkedinOrg(req, async () => {
    try {
      const formData = await req.formData().catch(() => null);
      if (!formData) return NextResponse.json({ ok: false, error: UNREADABLE_UPLOAD_MESSAGE }, { status: 400 });
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
      }
      const problem = spreadsheetUploadProblem(file);
      if (problem) return NextResponse.json({ ok: false, error: problem }, { status: file.size > SPREADSHEET_UPLOAD_MAX_BYTES ? 413 : 400 });
      const name = formData.get("name");
      if (typeof name !== "string" || !name.trim()) {
        return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });
      }

      const rawAccountIds = formData.get("accountIds");
      let accountIds: string[] = [];
      if (typeof rawAccountIds === "string" && rawAccountIds) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawAccountIds);
        } catch {
          return NextResponse.json({ ok: false, error: "accountIds must be valid JSON" }, { status: 400 });
        }
        if (!isStringArray(parsed)) {
          return NextResponse.json({ ok: false, error: "accountIds must be an array of strings" }, { status: 400 });
        }
        accountIds = parsed;
      }

      // Opt-in, like the JSON create route: an upload queues the URLs, Run starts them.
      const run = formData.get("run") === "true";

      let parsed: ReturnType<typeof parseSearchSheet>;
      try {
        parsed = parseSearchSheet(await file.arrayBuffer());
      } catch (error) {
        if (error instanceof SpreadsheetReadError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
        throw error;
      }
      const { rows, skipped } = parsed;
      if (rows.length === 0) {
        return NextResponse.json({ ok: false, error: "No valid rows with a Search URL found" }, { status: 400 });
      }

      let created: { id: string; queryCount: number };
      try {
        created = await createSearchBatch({ name, kind: "BULK", accountIds, rows });
      } catch (err) {
        if (err instanceof Error && err.message === "Unknown account") {
          return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
        }
        throw err;
      }
      const { id, queryCount } = created;
      const runResult = run ? await startSearchBatchRun(id) : null;

      return NextResponse.json({ ok: true, id, queryCount, skipped, run: runResult });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  });
}
