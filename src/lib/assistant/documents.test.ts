import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { DocumentReadError, documentKind, extractDocumentText, tidyText } from "./documents.server";

/** A one-page PDF whose page draws `text`, with a correct xref table. */
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A minimal .docx with one paragraph per entry. */
function tinyDocx(paragraphs: string[]): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(document),
  });
}

describe("extractDocumentText", () => {
  test("reads a PDF's text", async () => {
    const result = await extractDocumentText("brochure.pdf", tinyPdf("Teeth whitening from 4999 INR"));
    expect(result.kind).toBe("pdf");
    expect(result.text).toContain("Teeth whitening from 4999 INR");
  });

  test("reads a Word document's paragraphs", async () => {
    const result = await extractDocumentText("offer.docx", tinyDocx(["Our offer", "Free first consultation"]));
    expect(result.kind).toBe("docx");
    expect(result.text).toContain("Our offer");
    expect(result.text).toContain("Free first consultation");
  });

  test("reads plain text and tidies whitespace", async () => {
    const result = await extractDocumentText("notes.txt", new TextEncoder().encode("Line one   \r\n\r\n\r\n\r\nLine\t two"));
    expect(result).toEqual({ kind: "text", text: "Line one\n\nLine two", truncated: false });
  });

  test("explains what to do with unsupported, empty or damaged files", async () => {
    await expect(extractDocumentText("old.doc", new Uint8Array([1]))).rejects.toThrow(".docx or PDF");
    await expect(extractDocumentText("image.png", new Uint8Array([1]))).rejects.toThrow("Upload a PDF");
    await expect(extractDocumentText("empty.txt", new Uint8Array())).rejects.toThrow("is empty");
    await expect(extractDocumentText("broken.pdf", new TextEncoder().encode("not a pdf"))).rejects.toBeInstanceOf(DocumentReadError);
    await expect(extractDocumentText("broken.docx", new TextEncoder().encode("not a zip"))).rejects.toThrow("Word document");
  });

  test("a PDF without text (a scan) is refused with the reason", async () => {
    await expect(extractDocumentText("scan.pdf", tinyPdf(""))).rejects.toThrow(/scan|no text|text/i);
  });

  test("helpers", () => {
    expect(documentKind("A.PDF")).toBe("pdf");
    expect(documentKind("x.markdown")).toBe("text");
    expect(documentKind("list.csv")).toBeNull();
    expect(tidyText(" a \n\n\n\n b ")).toBe("a\n\nb");
  });
});
