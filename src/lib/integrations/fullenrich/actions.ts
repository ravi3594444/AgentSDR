import "server-only";

import { PermanentRunError } from "@/lib/grid/runners/types";
import type { CellResult, PendingCellResult } from "@/lib/grid/types";
import { asRecord, errorMessage, mapConfiguredOutputs, parseJson, truncate } from "../server/helpers";
import type { IntegrationActionContext, IntegrationActionHandlers } from "../server/types";
import { BRAND } from "@/lib/brand";

const API_BASE = "https://app.fullenrich.com/api/v2";

async function executeFullEnrich(
  context: IntegrationActionContext,
): Promise<CellResult | PendingCellResult> {
  const { action, config, credentials, inputs, providerState, signal, timeoutMs } = context;
  const enrichmentId = typeof providerState?.enrichmentId === "string" ? providerState.enrichmentId : null;
  const startedAt = typeof providerState?.startedAt === "number" ? providerState.startedAt : Date.now();
  if (Date.now() - startedAt > (action.async?.timeoutMs ?? 300_000)) {
    throw new PermanentRunError("FullEnrich did not finish this enrichment before its timeout");
  }

  if (!enrichmentId) {
    const enrichField = action.handlerKey === "fullenrich.findWorkEmail"
      ? "contact.work_emails"
      : action.handlerKey === "fullenrich.findMobilePhone"
        ? "contact.phones"
        : null;
    if (!enrichField) throw new PermanentRunError(`Unknown FullEnrich action: ${action.handlerKey}`);
    const started = await fetchFullEnrich(
      "/contact/enrich/bulk",
      credentials.apiKey,
      timeoutMs,
      signal,
      {
        method: "POST",
        body: JSON.stringify({
          name: `${BRAND.shortName} ${action.name}`,
          data: [{ linkedin_url: inputs.linkedinUrl, enrich_fields: [enrichField] }],
        }),
      },
    );
    assertFullEnrichResponse(started.response, started.body);
    const id = asRecord(started.body).enrichment_id;
    if (typeof id !== "string" || !id) {
      throw new Error("FullEnrich did not return an enrichment ID");
    }
    return {
      pending: true,
      state: { enrichmentId: id, startedAt, pollCount: 0 },
      pollAfterMs: action.async?.pollAfterMs ?? 3000,
    };
  }

  const polled = await fetchFullEnrich(
    `/contact/enrich/bulk/${encodeURIComponent(enrichmentId)}`,
    credentials.apiKey,
    timeoutMs,
    signal,
  );
  assertFullEnrichResponse(polled.response, polled.body);
  const root = asRecord(polled.body);
  const status = String(root.status ?? "").toUpperCase();
  if (status === "CREATED" || status === "IN_PROGRESS") {
    const pollCount = Number(providerState?.pollCount ?? 0) + 1;
    return {
      pending: true,
      state: { enrichmentId, startedAt, pollCount },
      pollAfterMs: Math.min(30_000, (action.async?.pollAfterMs ?? 3000) * Math.max(1, Math.ceil(pollCount / 3))),
    };
  }
  if (status === "CREDITS_INSUFFICIENT") {
    throw new PermanentRunError("FullEnrich account does not have enough credits");
  }
  if (status === "CANCELED") throw new PermanentRunError("FullEnrich canceled this enrichment");
  if (status !== "FINISHED") throw new Error(`FullEnrich returned an unknown status: ${status || "empty"}`);

  const record = Array.isArray(root.data) ? asRecord(root.data[0]) : {};
  const contactInfo = asRecord(record.contact_info);
  let logicalOutputs: Record<string, unknown>;
  let primary: unknown;
  if (action.handlerKey === "fullenrich.findWorkEmail") {
    const mostProbable = asRecord(contactInfo.most_probable_work_email);
    logicalOutputs = {
      workEmail: mostProbable.email,
      emailStatus: mostProbable.status,
      workEmails: contactInfo.work_emails,
    };
    primary = mostProbable.email;
  } else {
    const mostProbable = asRecord(contactInfo.most_probable_phone);
    logicalOutputs = {
      phoneNumber: mostProbable.number,
      region: mostProbable.region,
      phones: contactInfo.phones,
    };
    primary = mostProbable.number;
  }
  const found = primary !== null && primary !== undefined && primary !== "";
  return {
    value: found ? String(primary) : "Not found",
    outputs: mapConfiguredOutputs(config, logicalOutputs, polled.body),
    provider: "fullenrich",
    outcome: found ? "hit" : "miss",
    costCents: 0,
    latencyMs: polled.latencyMs,
    request: { method: "GET", endpoint: "/contact/enrich/bulk/:id", inputKeys: Object.keys(inputs) },
    response: truncate(polled.body),
  };
}

async function fetchFullEnrich(
  endpoint: string,
  apiKey: string,
  timeoutMs: number,
  outerSignal?: AbortSignal,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);
  const started = Date.now();
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, body: parseJson(text), latencyMs: Date.now() - started };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`FullEnrich request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function assertFullEnrichResponse(response: Response, body: unknown): void {
  if (response.ok) return;
  const message = `FullEnrich returned ${response.status}: ${errorMessage(body, "request failed")}`;
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new PermanentRunError(message);
  }
  throw new Error(message);
}

export const FULLENRICH_HANDLERS = {
  "fullenrich.findWorkEmail": executeFullEnrich,
  "fullenrich.findMobilePhone": executeFullEnrich,
} satisfies IntegrationActionHandlers;
