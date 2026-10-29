/**
 * Client-safe wrappers around the /api/calls and /api/calling routes, and the
 * page⇄extension bridge described in ./contract. Imports only types/constants
 * from the contract — no `db`, so this is safe from client components (see
 * the `.server.ts` note in CLAUDE.md).
 */

import type {
  AddCampaignContactRequest,
  CallDetail,
  CampaignContact,
  CampaignContactDetailResponse,
  CampaignDetailResponse,
  CampaignSummary,
  CreateCampaignRequest,
  ImportCampaignContactsResponse,
  ListCallsResponse,
  ListCampaignsResponse,
  LogCallMessageRequest,
  LogCallMessageResponse,
  RecorderBridgeReply,
  RecorderBridgeRequest,
  RecorderCallRequest,
  RecorderCallUpdate,
  RecorderEndCallRequest,
  RecorderUpdateRequest,
  RecorderMessageRequest,
  SetLeadStageRequest,
  StartCallRequest,
  StartCallResponse,
  UpdateCampaignContactPersonRequest,
  UpdateCampaignContactRequest,
  UpdateCampaignRequest,
} from "./contract";
import { MIN_RECORDER_VERSION, RECORDER_INSTALLED_ATTRIBUTE } from "./contract";
import { isOlderVersion, RECORDER_EXTENSION_NAME } from "./recorderRelease";

/** How long the extension has to answer a bridge request before we give up. */
const RECORDER_REPLY_TIMEOUT_MS = 5000;

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function callsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return jsonFetch<T>(`/api/calls${path}`, init);
}

function callingFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return jsonFetch<T>(`/api/calling${path}`, init);
}

// --- /api/calls --------------------------------------------------------

/** POST /api/calls — starts a call and returns the one-time recorder token. */
export function startCall(request: StartCallRequest): Promise<StartCallResponse> {
  return callsFetch<StartCallResponse>("", { method: "POST", body: JSON.stringify(request) });
}

/** GET /api/calls?personId=… — this person's call history, as the API returns it. */
export function listCalls(personId: string): Promise<ListCallsResponse> {
  return callsFetch<ListCallsResponse>(`?personId=${encodeURIComponent(personId)}`);
}

/** GET /api/calls/:id — a call with its transcript. */
export function getCall(callId: string): Promise<CallDetail> {
  return callsFetch<CallDetail>(`/${encodeURIComponent(callId)}`);
}

/** POST /api/calls/:id/transcribe — (re)runs transcription. */
/** POST /api/calls/:id/cancel — the rep cancels a call that has not connected. */
export function cancelCall(callId: string): Promise<CallDetail> {
  return callsFetch<CallDetail>(`/${encodeURIComponent(callId)}/cancel`, { method: "POST" });
}

export function transcribeCall(callId: string): Promise<CallDetail> {
  return callsFetch<CallDetail>(`/${encodeURIComponent(callId)}/transcribe`, { method: "POST" });
}

// --- /api/calling (the Calling section) ---------------------------------

/** GET /api/calling/campaigns */
export function listCampaigns(): Promise<ListCampaignsResponse> {
  return callingFetch<ListCampaignsResponse>("/campaigns");
}

/** POST /api/calling/campaigns */
export function createCampaign(request: CreateCampaignRequest): Promise<CampaignSummary> {
  return callingFetch<CampaignSummary>("/campaigns", { method: "POST", body: JSON.stringify(request) });
}

/** GET /api/calling/campaigns/:id — the campaign and its contacts. */
export function getCampaign(campaignId: string): Promise<CampaignDetailResponse> {
  return callingFetch<CampaignDetailResponse>(`/campaigns/${encodeURIComponent(campaignId)}`);
}

/** PATCH /api/calling/campaigns/:id — only the keys given change. */
export function updateCampaign(campaignId: string, request: UpdateCampaignRequest): Promise<CampaignSummary> {
  return callingFetch<CampaignSummary>(`/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "PATCH",
    body: JSON.stringify(request),
  });
}

/**
 * DELETE /api/calling/campaigns/:id — archives the campaign. It leaves the
 * Calling section; its contacts' calls, recordings and transcripts stay on
 * the people they belong to.
 */
export function deleteCampaign(campaignId: string): Promise<{ ok: true }> {
  return callingFetch<{ ok: true }>(`/campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" });
}

/** POST /api/calling/campaigns/:id/contacts — the add-a-contact form. */
export function addCampaignContact(campaignId: string, request: AddCampaignContactRequest): Promise<CampaignContact> {
  return callingFetch<CampaignContact>(`/campaigns/${encodeURIComponent(campaignId)}/contacts`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/**
 * POST /api/calling/campaigns/:id/contacts/import — multipart `file`
 * (CSV or XLSX; headers matched like the People import).
 */
export function importCampaignContacts(campaignId: string, file: File): Promise<ImportCampaignContactsResponse> {
  const form = new FormData();
  form.append("file", file);
  return callingFetch<ImportCampaignContactsResponse>(`/campaigns/${encodeURIComponent(campaignId)}/contacts/import`, {
    method: "POST",
    body: form,
  });
}

/** POST /api/calling/contacts/:id/photo — uploads an image as the person's photo. */
export function uploadContactPhoto(contactId: string, file: File): Promise<CampaignContact> {
  const form = new FormData();
  form.append("file", file);
  return callingFetch<CampaignContact>(`/contacts/${encodeURIComponent(contactId)}/photo`, { method: "POST", body: form });
}

/** GET /api/calling/contacts/:id — the contact, their calls and messages. */
export function getCampaignContact(contactId: string): Promise<CampaignContactDetailResponse> {
  return callingFetch<CampaignContactDetailResponse>(`/contacts/${encodeURIComponent(contactId)}`);
}

/** PATCH /api/calling/contacts/:id — set a call status by hand, the follow-up date, stage and/or notes. */
export function updateCampaignContact(contactId: string, request: UpdateCampaignContactRequest): Promise<CampaignContact> {
  return callingFetch<CampaignContact>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify(request),
  });
}

/** PATCH /api/calling/contacts/:id/stage — sets the lead's CRM stage by hand. */
export function setLeadStage(contactId: string, request: SetLeadStageRequest): Promise<CampaignContact> {
  return callingFetch<CampaignContact>(`/contacts/${encodeURIComponent(contactId)}/stage`, {
    method: "PATCH",
    body: JSON.stringify(request),
  });
}

/**
 * GET /api/crm/categories — the CRM's categories with their subcategories,
 * as the CRM's own ClassificationPicker takes them.
 */
export async function listCrmCategories(): Promise<Record<string, unknown>[]> {
  const body = await jsonFetch<{ categories?: Record<string, unknown>[] }>("/api/crm/categories");
  return Array.isArray(body.categories) ? body.categories : [];
}

/**
 * POST /api/calling/contacts/:id/messages — log a follow-up the page is
 * about to open in WhatsApp.
 */
export function logCallMessage(contactId: string, request: LogCallMessageRequest): Promise<LogCallMessageResponse> {
  return callingFetch<LogCallMessageResponse>(`/contacts/${encodeURIComponent(contactId)}/messages`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/**
 * DELETE /api/calling/contacts/:id — takes the person off the campaign; the
 * person, their calls and recordings stay.
 */
export function removeCampaignContact(contactId: string): Promise<{ ok: true }> {
  return callingFetch<{ ok: true }>(`/contacts/${encodeURIComponent(contactId)}`, { method: "DELETE" });
}

/**
 * PATCH /api/calling/contacts/:id/person — edits the People record behind
 * a campaign contact, shared across AgentSDR.
 */
export function updateCampaignContactPerson(
  contactId: string,
  request: UpdateCampaignContactPersonRequest,
): Promise<CampaignContact> {
  return callingFetch<CampaignContact>(`/contacts/${encodeURIComponent(contactId)}/person`, {
    method: "PATCH",
    body: JSON.stringify(request),
  });
}

// --- Page ⇄ extension bridge --------------------------------------------

/**
 * The extension's content script marks the page's <html> element once it has
 * loaded, so the UI can tell "no extension" apart from "extension installed
 * but didn't answer in time".
 */
export function isRecorderInstalled(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.hasAttribute(RECORDER_INSTALLED_ATTRIBUTE);
}

/**
 * Marks a call failed when the extension never took it, so it doesn't sit in
 * the history as "Waiting" forever. Uses the call's own recorder token, the
 * same way the extension would report it. Best-effort: never throws.
 */
export async function abandonCall(callId: string, recorderToken: string, error: string): Promise<void> {
  try {
    await fetch(`/api/call-recorder/calls/${callId}/finish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${recorderToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "failed", error }),
    });
  } catch {
    // The call stays pending; nothing the rep can do about it here.
  }
}

/** The installed extension's version, as its content script stamped it. */
export function recorderVersion(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.getAttribute(RECORDER_INSTALLED_ATTRIBUTE);
}

/** True when `version` is older than MIN_RECORDER_VERSION (or unreadable). */
export function isRecorderOutdated(version: string | null): boolean {
  return !version || isOlderVersion(version, MIN_RECORDER_VERSION);
}

/**
 * The three bridge request variants, minus the fields this wrapper fills in
 * itself. Written as a union of per-variant `Omit`s — rather than one
 * `Omit<RecorderBridgeRequest, …>` — because `Omit` applied directly to a
 * union collapses it to the *common* keys first (it's defined via `keyof`,
 * which intersects over a union) and loses the per-variant fields (`callId`,
 * `recorderToken`, `text`) entirely. Omitting from each member first, then
 * unioning, keeps the discriminated union intact.
 */
export type RecorderBridgeMessage =
  | Omit<RecorderCallRequest, "source" | "requestId" | "apiBase">
  | Omit<RecorderMessageRequest, "source" | "requestId">
  | Omit<RecorderEndCallRequest, "source" | "requestId">
  | Omit<RecorderUpdateRequest, "source" | "requestId">;

/**
 * Hands a call:start, message:open, or call:end request off to the recorder
 * extension over window.postMessage and waits for its reply. `source` and
 * `requestId` are filled in here rather than by the caller — `requestId`
 * correlates the reply, and is meaningless coming from anywhere but this
 * bridge. `apiBase` is only meaningful (and only present) on the call
 * variant, so it is filled in only for "call:start".
 */
export function sendToRecorder(message: RecorderBridgeMessage): Promise<RecorderBridgeReply> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const request: RecorderBridgeRequest =
      message.type === "call:start"
        ? { ...message, source: "agentsdr-app", requestId, apiBase: window.location.origin }
        : { ...message, source: "agentsdr-app", requestId };

    let settled = false;

    // `timer` is read by these two function declarations before it is
    // declared below, which is fine — both are hoisted and only ever called
    // asynchronously, by which point the assignment has already run.
    function cleanup() {
      window.removeEventListener("message", handleMessage);
      clearTimeout(timer);
    }

    function handleMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data as Partial<RecorderBridgeReply> | null | undefined;
      if (!data || data.source !== "agentsdr-recorder" || data.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data as RecorderBridgeReply);
    }

    window.addEventListener("message", handleMessage);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`The ${RECORDER_EXTENSION_NAME} extension didn't respond. If it was just reloaded or updated, reload this page.`));
    }, RECORDER_REPLY_TIMEOUT_MS);

    window.postMessage(request, window.location.origin);
  });
}

/**
 * Opens a WhatsApp chat with `text` typed in, ready for the rep to send.
 * Reuses the rep's existing WhatsApp Web tab through the recorder extension
 * when it's installed; otherwise falls back to a plain web.whatsapp.com deep
 * link in a new tab. If the extension is installed but doesn't accept the
 * request (rejected, or didn't answer in time), falls back to the same deep
 * link rather than leaving the rep with no way to send the message.
 */
export async function openWhatsAppMessage(phone: string, text: string): Promise<void> {
  if (isRecorderInstalled()) {
    try {
      const reply = await sendToRecorder({ type: "message:open", phone, text });
      if (reply.type === "message:opened") return;
    } catch {
      // Fall through to the deep link below.
    }
  }
  const digits = phone.replace(/[^\d]/g, "");
  window.open(`https://web.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
}

/**
 * Asks the recorder extension to hang up a call it placed — presses
 * WhatsApp's own End call button on the rep's behalf. Throws with the
 * extension's own error message when it rejects the request (e.g. the call
 * already ended) or doesn't answer in time.
 */
export async function endCallViaRecorder(callId: string): Promise<void> {
  const reply = await sendToRecorder({ type: "call:end", callId });
  if (reply.type === "call:end-accepted") return;
  const error = reply.type === "call:end-rejected" ? reply.error : "Something went wrong. Please try again.";
  throw new Error(error);
}

/**
 * Listens for the extension's unprompted call:update pushes — the live
 * phase of a call it placed, as it changes, so the rep can watch the call
 * without leaving this tab. Only accepts messages that could only have come
 * from the recorder's own script running on this page: same-window source,
 * this page's own origin, and the bridge's source/type tags. Returns an
 * unsubscribe function.
 */
export function subscribeToCallUpdates(listener: (update: RecorderCallUpdate) => void): () => void {
  function handleMessage(event: MessageEvent) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data as Partial<RecorderCallUpdate> | null | undefined;
    if (!data || data.source !== "agentsdr-recorder" || data.type !== "call:update") return;
    listener(data as RecorderCallUpdate);
  }
  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}
