import type { NextRequest } from "next/server";
import { AssistantBusyError, runAgentTurn } from "@/lib/assistant/agent.server";
import { assistantRoute, assistantState } from "@/lib/assistant/http.server";
import { attachmentKind, ingestAttachment, type IngestResult } from "@/lib/assistant/ingest.server";
import type { AssistantAttachment } from "@/lib/assistant/schema";
import { resolveThread, threadBusy } from "@/lib/assistant/threads.server";

export const dynamic = "force-dynamic";

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 8_000;

function attachmentSummary(result: IngestResult): { tool: string; ok: boolean; summary: string; data?: Record<string, unknown> } {
  if (!result.ok) return { tool: result.kind === "contacts" ? "import_contacts" : "read_document", ok: false, summary: `${result.fileName}: ${result.error}` };
  if (result.kind === "document") {
    return {
      tool: "read_document",
      ok: true,
      summary: `Saved “${result.title}” (${result.characters.toLocaleString("en-US")} characters) to the knowledge base${result.truncated ? "; it was longer than 200,000 characters, so the rest was cut" : ""}. Messages and reply drafts can now use it.`,
      data: result as unknown as Record<string, unknown>,
    };
  }
  const audience = result.audience;
  return {
    tool: "import_contacts",
    ok: true,
    summary: `Imported ${result.fileName}: ${result.imported.created} new and ${result.imported.updated} existing people${result.imported.failed ? `, ${result.imported.failed} ${result.imported.failed === 1 ? "row" : "rows"} failed (${result.failures.slice(0, 3).map((f) => `row ${f.row}: ${f.error}`).join("; ")})` : ""}${result.imported.skippedNoIdentity ? `, ${result.imported.skippedNoIdentity} ${result.imported.skippedNoIdentity === 1 ? "row has" : "rows had"} no email, LinkedIn or phone` : ""}. Lead list ${result.audienceId}: ${audience?.eligible ?? 0} contactable (email ${audience?.byChannel.email ?? 0}, WhatsApp ${audience?.byChannel.whatsapp ?? 0}, LinkedIn ${audience?.byChannel.linkedin ?? 0})${audience?.excluded.length ? `; left out: ${audience.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ")}` : ""}.`,
    data: { ...result, audienceId: result.audienceId } as unknown as Record<string, unknown>,
  };
}

// POST /api/assistant/messages — multipart: threadId?, text, files (up to 5).
// Files are handled first (documents → knowledge, contact lists → a lead
// list), then the assistant takes its turn. Answers with the thread when the
// turn is over; the page polls GET /api/assistant meanwhile to show progress.
export async function POST(request: NextRequest) {
  return assistantRoute(request, { mutation: true }, async (ctx) => {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: "Send the message as a form (text and files)." }, { status: 400 });
    const text = String(form.get("text") ?? "").trim().slice(0, MAX_TEXT);
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    if (!text && !files.length) return Response.json({ error: "Write a message or attach a file." }, { status: 400 });
    if (files.length > MAX_FILES) return Response.json({ error: `Attach at most ${MAX_FILES} files at once.` }, { status: 400 });
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) return Response.json({ error: "The files are larger than 25 MB together; send them in smaller groups." }, { status: 413 });

    const requested = String(form.get("threadId") ?? "");
    const thread = await resolveThread(/^[0-9a-f-]{36}$/i.test(requested) ? requested : null, ctx.userId);
    // Before any file is imported: a busy thread refuses the whole message.
    if (await threadBusy(thread.id)) return Response.json({ error: new AssistantBusyError().message }, { status: 409 });
    const attachments: AssistantAttachment[] = files.map((file) => ({ name: file.name, kind: attachmentKind(file.name) === "contacts" ? "contacts" : "document", bytes: file.size }));
    const attachmentResults = [];
    for (const file of files) {
      const result = await ingestAttachment({ name: file.name, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type }, { threadId: thread.id, userId: ctx.userId });
      const summary = attachmentSummary(result);
      attachmentResults.push({ tool: summary.tool, input: { file: file.name }, result: { ok: summary.ok, summary: summary.summary, data: summary.data } });
    }
    try {
      await runAgentTurn({
        threadId: thread.id,
        userId: ctx.userId,
        text: text || (files.length ? `(attached ${files.map((file) => file.name).join(", ")})` : ""),
        attachments,
        attachmentResults,
      });
    } catch (error) {
      if (error instanceof AssistantBusyError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
    return Response.json(await assistantState(thread.id, ctx, false));
  });
}
