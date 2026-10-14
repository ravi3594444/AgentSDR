// Next.js calls register() exactly once when the server process boots.
// Starts the background loops: the outreach send tick and WhatsApp campaign
// sender (single-instance, see their internalScheduler.ts), and the
// scheduled jobs (src/lib/scheduler/internalScheduler.ts: each organization's
// daily rollover at its own new-day time, LinkedIn outreach, webhook replay,
// history pruning). Those run on fixed clock slots claimed in the database,
// so restarts do not shift them and overlapping instances run each slot once.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // skip edge runtime invocations

  // The public demo is read-only fictional data: nothing may send, sync,
  // enrich or call a model, so none of the loops below start
  // (src/lib/demo/mode.ts). Only its clock runs, keeping the data current.
  const { isDemoMode } = await import("./lib/demo/mode");
  if (isDemoMode()) {
    const { startDemoClock } = await import("./lib/demo/clock");
    startDemoClock();
    return;
  }

  // Outreach remains production-only: it is not backed by a distributed
  // claim lock and duplicate dev hot-reload loops could double-send messages.
  if (process.env.NODE_ENV === "production") {
    const { startInternalOutreachScheduler } = await import("./lib/outreach/internalScheduler");
    startInternalOutreachScheduler();
    const { startInternalWhatsappCampaignScheduler } = await import("./lib/whatsapp/campaigns/internalScheduler");
    startInternalWhatsappCampaignScheduler();
  }

  // Scheduled jobs; INTERNAL_SCHEDULER=false leaves them to an external cron.
  const { internalSchedulerEnabled } = await import("./lib/scheduler/config");
  if (internalSchedulerEnabled()) {
    const { startInternalScheduler } = await import("./lib/scheduler/internalScheduler");
    startInternalScheduler();
  }

  // Enrichment cell worker. Unlike the outreach tick above, this one claims
  // work with SKIP LOCKED, so it is safe in development too. Keeping it active
  // here is essential: manual runs otherwise remain queued forever in next dev.
  const { startGridWorker } = await import("./lib/grid/worker");
  startGridWorker();

  // CRM only claims durable AI classification/drafting jobs for registered
  // handlers, plus the reply autopilot's auto_send jobs, which send only when
  // an organization turned the autopilot on and only in production
  // (src/lib/crm/autopilot.server.ts). SKIP LOCKED keeps this safe when
  // multiple app instances overlap during a deployment.
  const { registerDefaultCrmJobHandlers } = await import("./lib/crm/handlers");
  registerDefaultCrmJobHandlers();
  const { startCrmWorker } = await import("./lib/crm/worker");
  startCrmWorker();

  // The owner's assistant: lead searches and the start of approved outreach,
  // claimed with SKIP LOCKED and resumed by stage after a restart. It sends
  // nothing itself; the campaign engines above do, under their own rules.
  const { registerAssistantJobs } = await import("./lib/assistant/register.server");
  registerAssistantJobs();
  const { startAssistantWorker } = await import("./lib/assistant/worker");
  startAssistantWorker();
}
