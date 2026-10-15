import "server-only";

import { parseImportRows } from "@/lib/leads/importRows";
import { importPeopleRows } from "@/lib/leads/peopleImport.server";
import { SPREADSHEET_UPLOAD_MAX_BYTES, spreadsheetUploadProblem } from "@/lib/spreadsheet/upload";
import { addAudienceMembers, createAudience, summarizeAudience, type AudienceSummary } from "./audiences.server";
import { documentKind, DocumentReadError, extractDocumentText } from "./documents.server";
import { saveDocumentKnowledge } from "./profile.server";

/**
 * What happens to a file the owner attaches in the chat, decided by its
 * type and done before the assistant answers: a document (PDF, DOCX, TXT)
 * becomes a knowledge document; a contact list (CSV, XLSX) goes through the
 * People import and becomes an audience. Each returns a result the chat
 * shows as it is, errors included.
 */

const CONTACT_LIST = /\.(?:csv|tsv|xlsx|xlsm|xls|ods)$/i;
const MAX_LIST_ROWS = 5_000;

export type IngestResult =
  | { kind: "document"; ok: true; fileName: string; knowledgeId: string; title: string; characters: number; truncated: boolean }
  | { kind: "contacts"; ok: true; fileName: string; audienceId: string; imported: { created: number; updated: number; failed: number; skippedNoIdentity: number }; failures: { row: number; identity: string; error: string }[]; warnings: { row: number; identity: string; message: string }[]; audience: AudienceSummary | null }
  | { kind: "document" | "contacts" | "unknown"; ok: false; fileName: string; error: string };

export function attachmentKind(fileName: string): "document" | "contacts" | null {
  if (CONTACT_LIST.test(fileName)) return "contacts";
  // .txt is a document here; a contact list in a .txt is rare and the CSV path handles .csv.
  if (documentKind(fileName)) return "document";
  return null;
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || fileName;
}

export async function ingestAttachment(
  file: { name: string; size: number; bytes: Uint8Array; type?: string },
  context: { threadId: string | null; userId: string | null },
): Promise<IngestResult> {
  const kind = attachmentKind(file.name);
  if (kind === "document") {
    try {
      const extracted = await extractDocumentText(file.name, file.bytes);
      const saved = await saveDocumentKnowledge(titleFromFileName(file.name), extracted.text);
      return { kind, ok: true, fileName: file.name, knowledgeId: saved.id, title: saved.title, characters: extracted.text.length, truncated: extracted.truncated };
    } catch (error) {
      if (error instanceof DocumentReadError) return { kind, ok: false, fileName: file.name, error: error.message };
      throw error;
    }
  }
  if (kind === "contacts") {
    const problem = spreadsheetUploadProblem({ name: file.name, size: file.size }, SPREADSHEET_UPLOAD_MAX_BYTES);
    if (problem) return { kind, ok: false, fileName: file.name, error: problem };
    let rows;
    try {
      rows = parseImportRows(file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer);
    } catch (error) {
      return { kind, ok: false, fileName: file.name, error: error instanceof Error ? error.message : "Could not read that file." };
    }
    if (rows.length > MAX_LIST_ROWS) return { kind, ok: false, fileName: file.name, error: `${file.name} has ${rows.length} rows; split it into files of at most ${MAX_LIST_ROWS}.` };
    const result = await importPeopleRows(rows);
    if (!result.personIds.length) {
      const reason = result.failed[0]?.error ?? "no row has an email, a LinkedIn URL or a phone number";
      return { kind, ok: false, fileName: file.name, error: `Nothing could be imported from ${file.name}: ${reason}.` };
    }
    const audienceId = await createAudience({
      name: titleFromFileName(file.name),
      source: "list",
      criteria: { fileName: file.name, imported: { created: result.created, updated: result.updated, failed: result.failed.length, skippedNoIdentity: result.skippedNoIdentity } },
      threadId: context.threadId,
      userId: context.userId,
    });
    await addAudienceMembers(audienceId, result.personIds.map((personId) => ({ personId, source: "list" })));
    return {
      kind,
      ok: true,
      fileName: file.name,
      audienceId,
      imported: { created: result.created, updated: result.updated, failed: result.failed.length, skippedNoIdentity: result.skippedNoIdentity },
      failures: result.failed.slice(0, 20),
      warnings: result.warnings.slice(0, 20),
      audience: await summarizeAudience(audienceId),
    };
  }
  return {
    kind: "unknown",
    ok: false,
    fileName: file.name,
    error: "Attach a document (PDF, Word .docx or .txt) about your business, or a contact list (CSV or Excel).",
  };
}
