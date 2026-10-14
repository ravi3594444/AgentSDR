import "server-only";

import { utf8Text } from "@/lib/spreadsheet/read";

/**
 * Text out of a document the owner gave the assistant (a brochure, price
 * list, case study, FAQ): PDF, Word (.docx) or plain text. The text goes into
 * the CRM knowledge base (knowledge.server.ts), where outreach and reply
 * drafts read it. Every failure says what to do instead.
 */

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** crm_knowledge_document_versions accepts up to 200,000 characters. */
export const DOCUMENT_MAX_CHARS = 200_000;

export class DocumentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentReadError";
  }
}

export type DocumentKind = "pdf" | "docx" | "text";

export function documentKind(fileName: string): DocumentKind | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "txt" || extension === "md" || extension === "markdown") return "text";
  return null;
}

/** Collapses the whitespace a PDF or Word extraction leaves, keeping paragraph breaks. */
export function tidyText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new DocumentReadError("This PDF is password-protected. Remove the password and upload it again.");
    throw new DocumentReadError("This file could not be opened as a PDF. Check that it is not damaged, or upload it as .docx or .txt.");
  }
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : text;
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  } catch {
    throw new DocumentReadError("This file could not be opened as a Word document (.docx). An old .doc file must be saved as .docx or PDF first.");
  }
}

export type ExtractedDocument = { kind: DocumentKind; text: string; truncated: boolean };

export async function extractDocumentText(fileName: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  const kind = documentKind(fileName);
  if (!kind) {
    if (/\.doc$/i.test(fileName)) throw new DocumentReadError("Old Word files (.doc) are not supported: save it as .docx or PDF and upload that.");
    throw new DocumentReadError("Upload a PDF, a Word document (.docx) or a text file (.txt). Contact lists go in as CSV or Excel.");
  }
  if (bytes.byteLength === 0) throw new DocumentReadError(`${fileName} is empty.`);
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new DocumentReadError(`${fileName} is larger than 10 MB. Upload a smaller file or paste the important part into the chat.`);

  let raw: string;
  if (kind === "pdf") raw = await pdfText(bytes);
  else if (kind === "docx") raw = await docxText(bytes);
  else {
    const decoded = utf8Text(bytes);
    if (decoded === null) throw new DocumentReadError(`${fileName} is not plain UTF-8 text. Save it as UTF-8 text, PDF or .docx.`);
    raw = decoded;
  }

  const text = tidyText(raw);
  if (!text) {
    throw new DocumentReadError(kind === "pdf"
      ? `${fileName} has no selectable text: it looks like a scan or images. Text recognition (OCR) is not supported; upload a text PDF, a .docx, or paste the text.`
      : `${fileName} has no text in it.`);
  }
  const truncated = text.length > DOCUMENT_MAX_CHARS;
  return { kind, text: truncated ? text.slice(0, DOCUMENT_MAX_CHARS) : text, truncated };
}
