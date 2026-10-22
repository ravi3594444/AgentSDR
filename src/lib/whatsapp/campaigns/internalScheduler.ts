/**
 * In-process tick for WhatsApp campaigns, started from instrumentation.ts in
 * production only: like the email scheduler it has no distributed lock (the
 * per-step claim row prevents a double send, but two ticking instances would
 * still fight over numbers), and a dev server shares the production database.
 * Overlapping ticks are skipped and errors are logged, never thrown.
 */
import { runWhatsappCampaignTick } from "./engine";

const TICK_INTERVAL_MS = Number(process.env.WHATSAPP_CAMPAIGN_TICK_INTERVAL_MS ?? 10_000);

let started = false;
let tickRunning = false;
let tickCount = 0;

async function safeTick() {
  if (tickRunning) {
    console.warn("[whatsapp/campaigns/internalScheduler] previous tick still running — skipping this cycle");
    return;
  }
  tickRunning = true;
  try {
    const result = await runWhatsappCampaignTick();
    tickCount += 1;
    if (tickCount % 20 === 0 || result.sent > 0 || result.failed > 0 || result.replied > 0) {
      console.log(`[whatsapp/campaigns/internalScheduler] tick #${tickCount}:`, result);
    }
  } catch (err) {
    console.error("[whatsapp/campaigns/internalScheduler] tick threw:", err);
  } finally {
    tickRunning = false;
  }
}

/** Idempotent: only the first call starts the loop. */
export function startInternalWhatsappCampaignScheduler() {
  if (started) return;
  started = true;
  const interval = Number.isFinite(TICK_INTERVAL_MS) && TICK_INTERVAL_MS >= 1000 ? TICK_INTERVAL_MS : 10_000;
  console.log(`[whatsapp/campaigns/internalScheduler] starting — tick every ${interval}ms`);
  setInterval(safeTick, interval);
  setTimeout(safeTick, 7_000);
}
