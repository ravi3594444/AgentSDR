/**
 * Getting Started: what each setup step's state is, worked out from facts the
 * app already stores (readiness.server.ts gathers them). Pure and
 * client-safe, so the rules are unit-tested directly.
 *
 * Honest by construction: a status is only as strong as the evidence behind
 * it. "Connected" means saved credentials passed the live check made when
 * they were saved and an account is linked; nothing here claims that a
 * message was sent or a reply received. Facts carry no secrets, only
 * booleans, counts, dates and names.
 */

export type ReadinessStatus =
  | "not_configured"
  | "not_verified"
  | "needs_attention"
  | "connected"
  | "to_do"
  | "done"
  | "clear";

export const READINESS_LABEL: Record<ReadinessStatus, string> = {
  not_configured: "Not configured",
  not_verified: "Not yet verified",
  needs_attention: "Needs attention",
  connected: "Connected",
  to_do: "To do",
  done: "Done",
  clear: "Nothing waiting",
};

/** Badge colours (AlignUI Badge `color`), always shown with the label. */
export const READINESS_COLOR: Record<ReadinessStatus, "gray" | "orange" | "red" | "green"> = {
  not_configured: "gray",
  not_verified: "orange",
  needs_attention: "red",
  connected: "green",
  to_do: "gray",
  done: "green",
  clear: "green",
};

/** A step counts toward progress when nothing is left to do on it. */
export const isReady = (status: ReadinessStatus) => status === "connected" || status === "done" || status === "clear";

export type ReadinessKey = "workspace" | "email" | "linkedin" | "whatsapp" | "ai" | "leads" | "campaigns" | "replies";

export type ReadinessItem = {
  key: ReadinessKey;
  title: string;
  status: ReadinessStatus;
  /** One line: what is true now. */
  summary: string;
  /** Supporting facts: counts, dates. */
  details: string[];
  /** The next thing to do, or null when there is nothing. */
  next: string | null;
  links: { href: string; label: string }[];
};

// ── Facts ────────────────────────────────────────────────────────────────────

export type PlatformFacts = { connected: boolean; verifiedAt: string | null };

/** Unipile webhook registration as stored on save (catalog.ts UnipileWebhookRegistration). */
export type WebhookFacts = { status: "registered" | "skipped" | "failed"; message?: string } | null;

export type ReadinessFacts = {
  workspace: {
    organizationName: string;
    roleLabel: string;
    members: number;
    pendingInvitations: number;
    /** RESEND_API_KEY and AUTH_EMAIL_FROM are both set. */
    authEmailConfigured: boolean;
  };
  /** May this person change integrations and AI settings (owner or admin)? */
  canManage: boolean;
  google: PlatformFacts & { replySyncTopicSet: boolean };
  mailboxes: { connected: number; connecting: number; failed: number; disabled: number };
  unipile: PlatformFacts & { webhooks: WebhookFacts };
  linkedinAccounts: { connected: number; disconnected: number };
  whatsappAccounts: { connected: number; notConnected: number };
  ai: {
    connectionSaved: boolean;
    connectionVerified: boolean;
    providers: number;
    defaultModel: { provider: string; modelId: string } | null;
    /** The default model's provider is enabled and the model is in its list. */
    defaultModelEnabled: boolean;
    routingConfirmed: boolean;
  };
  people: number;
  campaigns: {
    email: { active: number; paused: number; draft: number; completed: number };
    linkedin: { active: number; paused: number };
    whatsapp: { active: number; paused: number };
  };
  replies: { actionRequired: number; draftsAwaitingReview: number };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const verifiedLine = (verifiedAt: string | null) => {
  if (!verifiedAt) return null;
  const date = new Date(verifiedAt);
  return Number.isNaN(date.getTime()) ? null : `Credentials passed a live check on ${date.toISOString().slice(0, 10)}.`;
};

/** Steps only an owner or admin may take say so to a member. */
function forRole(next: string | null, canManage: boolean): string | null {
  if (!next || canManage) return next;
  return `${next} Only an owner or admin can change this, so ask one of them.`;
}

// ── Rules ────────────────────────────────────────────────────────────────────

export function workspaceReadiness(facts: ReadinessFacts): ReadinessItem {
  const { workspace } = facts;
  const details = [
    `${plural(workspace.members, "member")}${workspace.pendingInvitations ? ` · ${plural(workspace.pendingInvitations, "pending invitation")}` : ""}`,
  ];
  return {
    key: "workspace",
    title: "Owner and workspace",
    status: "done",
    summary: `${workspace.organizationName}: you are ${workspace.roleLabel.toLowerCase()}.`,
    details,
    next: workspace.authEmailConfigured
      ? null
      : "Invitation and password-reset emails are written to the server log, not sent, until RESEND_API_KEY and AUTH_EMAIL_FROM are set on the server.",
    links: [
      { href: "/settings/organization", label: "Organization" },
      { href: "/settings/members", label: "Members" },
    ],
  };
}

export function emailReadiness(facts: ReadinessFacts): ReadinessItem {
  const { google, mailboxes, canManage } = facts;
  const links = [
    { href: "/settings/email-connection", label: "Email connection" },
    { href: "/settings/email-accounts", label: "Mailboxes" },
  ];
  const base = { key: "email" as const, title: "Email (Google Workspace)", links };
  if (!google.connected) {
    return {
      ...base,
      status: "not_configured",
      summary: "Google Workspace is not connected.",
      details: ["Email sends through a Google Workspace service account with domain-wide delegation. Personal Gmail accounts are not supported."],
      next: forRole("Connect Google Workspace on the Email connection page.", canManage),
    };
  }
  const details = [
    verifiedLine(google.verifiedAt),
    `Mailboxes: ${mailboxes.connected} connected${mailboxes.connecting ? ` · ${mailboxes.connecting} connecting` : ""}${mailboxes.failed ? ` · ${mailboxes.failed} failed` : ""}${mailboxes.disabled ? ` · ${mailboxes.disabled} disabled` : ""}.`,
    google.replySyncTopicSet ? "Reply sync: a Gmail Pub/Sub topic is set." : "Reply sync: no Gmail Pub/Sub topic is set.",
  ].filter((line): line is string => Boolean(line));
  if (mailboxes.failed > 0) {
    return {
      ...base,
      status: "needs_attention",
      summary: `${plural(mailboxes.failed, "mailbox", "mailboxes")} failed the last check.`,
      details,
      next: forRole("Open Mailboxes, read the error on the failing mailbox and test it again.", canManage),
    };
  }
  if (mailboxes.connected === 0) {
    return {
      ...base,
      status: "not_verified",
      summary: "Google Workspace is connected, but no mailbox is connected yet.",
      details,
      next: forRole("Add a mailbox on the Mailboxes page; adding it runs a live check.", canManage),
    };
  }
  if (!google.replySyncTopicSet) {
    return {
      ...base,
      status: "needs_attention",
      summary: "Email sends, but replies are not picked up, so follow-ups do not stop when someone answers.",
      details,
      next: forRole("Create a Gmail Pub/Sub topic and add it on the Email connection page.", canManage),
    };
  }
  return {
    ...base,
    status: "connected",
    summary: `${plural(mailboxes.connected, "mailbox", "mailboxes")} connected, with reply sync configured.`,
    details,
    next: null,
  };
}

/** The Unipile part shared by LinkedIn and WhatsApp: null when it is not the blocker. */
function unipileBlocker(facts: ReadinessFacts, channel: string): Omit<ReadinessItem, "key" | "title" | "links"> | null {
  const { unipile, canManage } = facts;
  if (!unipile.connected) {
    return {
      status: "not_configured",
      summary: "Unipile is not connected.",
      details: [`${channel} runs through your own Unipile workspace (API key and DSN).`],
      next: forRole(`Connect Unipile on the ${channel} connection page.`, canManage),
    };
  }
  if (unipile.webhooks?.status === "failed") {
    return {
      status: "needs_attention",
      summary: "Unipile webhooks failed to register, so replies and status changes do not arrive.",
      details: [unipile.webhooks.message, verifiedLine(unipile.verifiedAt)].filter((line): line is string => Boolean(line)),
      next: forRole(`Register the webhooks again on the ${channel} connection page.`, canManage),
    };
  }
  return null;
}

function webhookCaveat(facts: ReadinessFacts): { line: string; next: string } | null {
  const webhooks = facts.unipile.webhooks;
  if (webhooks?.status === "registered") return null;
  if (webhooks?.status === "skipped") {
    return {
      line: webhooks.message ?? "Webhooks were not registered because this server's address is not public.",
      next: "Inbound messages need a public HTTPS address: set APP_URL (or BETTER_AUTH_URL) to it, then save the Unipile connection again.",
    };
  }
  return {
    line: "No webhook registration is recorded for this Unipile connection.",
    next: "Save the Unipile connection again (or use Register again) so replies reach this workspace.",
  };
}

export function linkedinReadiness(facts: ReadinessFacts): ReadinessItem {
  const links = [
    { href: "/settings/linkedin-connection", label: "LinkedIn connection" },
    { href: "/settings/linkedin-accounts", label: "LinkedIn accounts" },
  ];
  const base = { key: "linkedin" as const, title: "LinkedIn", links };
  const blocker = unipileBlocker(facts, "LinkedIn");
  if (blocker) return { ...base, ...blocker };
  const { linkedinAccounts: accounts, canManage } = facts;
  const caveat = webhookCaveat(facts);
  const details = [
    verifiedLine(facts.unipile.verifiedAt),
    `LinkedIn accounts: ${accounts.connected} connected${accounts.disconnected ? ` · ${accounts.disconnected} disconnected` : ""}.`,
    caveat?.line ?? null,
  ].filter((line): line is string => Boolean(line));
  if (accounts.disconnected > 0) {
    return {
      ...base,
      status: "needs_attention",
      summary: `${plural(accounts.disconnected, "LinkedIn account")} disconnected.`,
      details,
      next: "Reconnect it on the LinkedIn accounts page.",
    };
  }
  if (accounts.connected === 0) {
    return {
      ...base,
      status: "not_verified",
      summary: "Unipile is connected, but no LinkedIn account is linked.",
      details,
      next: forRole("Link a LinkedIn account on the LinkedIn accounts page (Unipile's hosted sign-in).", canManage),
    };
  }
  if (caveat) {
    return { ...base, status: "not_verified", summary: `${plural(accounts.connected, "LinkedIn account")} linked; inbound messages are not set up.`, details, next: forRole(caveat.next, canManage) };
  }
  return { ...base, status: "connected", summary: `${plural(accounts.connected, "LinkedIn account")} linked, with webhooks registered.`, details, next: null };
}

export function whatsappReadiness(facts: ReadinessFacts): ReadinessItem {
  const links = [
    { href: "/settings/whatsapp-connection", label: "WhatsApp connection" },
    { href: "/settings/whatsapp-accounts", label: "WhatsApp accounts" },
  ];
  const base = { key: "whatsapp" as const, title: "WhatsApp", links };
  const blocker = unipileBlocker(facts, "WhatsApp");
  if (blocker) return { ...base, ...blocker };
  const { whatsappAccounts: accounts, canManage } = facts;
  const caveat = webhookCaveat(facts);
  const details = [
    verifiedLine(facts.unipile.verifiedAt),
    `WhatsApp numbers: ${accounts.connected} connected${accounts.notConnected ? ` · ${accounts.notConnected} need attention` : ""}.`,
    "New numbers send no new chats for their first 24 hours, then a limited number a day (Sending rules).",
    caveat?.line ?? null,
  ].filter((line): line is string => Boolean(line));
  if (accounts.notConnected > 0) {
    return {
      ...base,
      status: "needs_attention",
      summary: `${plural(accounts.notConnected, "WhatsApp number")} not connected.`,
      details,
      next: "Relink the number in the Unipile dashboard, then press Sync from Unipile on WhatsApp accounts.",
    };
  }
  if (accounts.connected === 0) {
    return {
      ...base,
      status: "not_verified",
      summary: "Unipile is connected, but no WhatsApp number is synced.",
      details,
      next: forRole("Link the number in the Unipile dashboard (scan its QR code there), then press Sync from Unipile on WhatsApp accounts.", canManage),
    };
  }
  if (caveat) {
    return { ...base, status: "not_verified", summary: `${plural(accounts.connected, "WhatsApp number")} synced; inbound messages are not set up.`, details, next: forRole(caveat.next, canManage) };
  }
  return { ...base, status: "connected", summary: `${plural(accounts.connected, "WhatsApp number")} synced, with webhooks registered.`, details, next: null };
}

/** Mirrors the gate every model call passes (src/lib/ai/server/runtime.ts), in the order a person fixes it. */
export function aiReadiness(facts: ReadinessFacts): ReadinessItem {
  const { ai, canManage } = facts;
  const base = {
    key: "ai" as const,
    title: "AI drafting and reply sorting",
    links: [{ href: "/settings/ai", label: "AI provider" }],
  };
  const notReady = (summary: string, next: string, status: ReadinessStatus = "not_configured"): ReadinessItem => ({
    ...base,
    status,
    summary,
    details: ["Uses your own OpenRouter account with your own provider keys (BYOK). Replies are sorted and drafts written; drafts wait for your review."],
    next: forRole(next, canManage),
  });
  if (!ai.connectionSaved) return notReady("OpenRouter is not connected.", "Add your OpenRouter inference key and management key under Settings → AI provider.");
  if (!ai.connectionVerified) return notReady("The saved OpenRouter keys did not pass verification.", "Enter both OpenRouter keys again under Settings → AI provider.", "needs_attention");
  if (ai.providers === 0) return notReady("OpenRouter is connected, but no BYOK provider is enabled.", "Enable a provider whose key you added in OpenRouter's BYOK settings.");
  if (!ai.defaultModel || !ai.defaultModelEnabled) return notReady("OpenRouter is connected, but no usable default model is chosen.", "Choose a default model from an enabled provider.");
  if (!ai.routingConfirmed) {
    return notReady(
      "OpenRouter is connected, but BYOK-only routing is not confirmed, so AI calls are blocked.",
      "In OpenRouter, set each enabled provider to never use shared capacity, then tick the confirmation under Settings → AI provider.",
    );
  }
  return {
    ...base,
    status: "connected",
    summary: `Ready: ${ai.defaultModel.modelId} through ${ai.defaultModel.provider}.`,
    details: ["AI drafts wait in Action required for your review; none is sent without your approval."],
    next: null,
  };
}

export function leadsReadiness(facts: ReadinessFacts): ReadinessItem {
  const base = { key: "leads" as const, title: "Leads", links: [{ href: "/leads", label: "Leads" }] };
  if (facts.people === 0) {
    return {
      ...base,
      status: "to_do",
      summary: "No people yet.",
      details: ["Import a CSV or Excel file (an Email or LinkedIn URL column identifies each person). The import menu also has a template."],
      next: "Import a small list first and check the result.",
    };
  }
  return { ...base, status: "done", summary: `${plural(facts.people, "person", "people")} in this workspace.`, details: [], next: null };
}

export function campaignsReadiness(facts: ReadinessFacts, channels: { email: ReadinessItem; linkedin: ReadinessItem; whatsapp: ReadinessItem }): ReadinessItem {
  const { email, linkedin, whatsapp } = facts.campaigns;
  const links = [
    { href: "/outreach/campaigns", label: "Email campaigns" },
    { href: "/linkedin/campaigns", label: "LinkedIn campaigns" },
    { href: "/whatsapp/campaigns", label: "WhatsApp campaigns" },
  ];
  const base = { key: "campaigns" as const, title: "First campaign", links };
  const total = email.active + email.paused + email.draft + email.completed + linkedin.active + linkedin.paused + whatsapp.active + whatsapp.paused;
  if (total === 0) {
    return {
      ...base,
      status: "to_do",
      summary: "No campaigns yet.",
      details: ["Each campaign sends through one channel and follows that channel's Sending rules. Check its steps and limits before you start it; pause it any time."],
      next: "Create a campaign on the channel you connected first.",
    };
  }
  const describe = (counts: Record<string, number>) =>
    Object.entries(counts).filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`).join(" · ") || "none";
  const details = [`Email: ${describe(email)}.`, `LinkedIn: ${describe(linkedin)}.`, `WhatsApp: ${describe(whatsapp)}.`];
  const stalled = [
    email.active > 0 && channels.email.status === "not_configured" ? "email" : null,
    linkedin.active > 0 && channels.linkedin.status === "not_configured" ? "LinkedIn" : null,
    whatsapp.active > 0 && channels.whatsapp.status === "not_configured" ? "WhatsApp" : null,
  ].filter((channel): channel is string => Boolean(channel));
  if (stalled.length) {
    return {
      ...base,
      status: "needs_attention",
      summary: `Active ${stalled.join(" and ")} campaigns cannot send: the channel is not connected.`,
      details,
      next: "Connect the channel, or pause the campaign until it is.",
    };
  }
  return { ...base, status: "done", summary: `${plural(total, "campaign")} (${email.active + linkedin.active + whatsapp.active} active).`, details, next: null };
}

export function repliesReadiness(facts: ReadinessFacts): ReadinessItem {
  const { actionRequired, draftsAwaitingReview } = facts.replies;
  const base = { key: "replies" as const, title: "Replies", links: [{ href: "/crm/actions", label: "Action required" }] };
  if (actionRequired + draftsAwaitingReview > 0) {
    return {
      ...base,
      status: "needs_attention",
      summary: [actionRequired ? `${plural(actionRequired, "conversation")} need${actionRequired === 1 ? "s" : ""} action` : null, draftsAwaitingReview ? `${plural(draftsAwaitingReview, "draft")} awaiting review` : null].filter(Boolean).join(" · ") + ".",
      details: ["A reply on any channel stops that person's campaign follow-ups on every channel. Review each draft, edit it if needed, then send it."],
      next: "Open Action required.",
    };
  }
  return {
    ...base,
    status: "clear",
    summary: "Nothing waiting.",
    details: ["Replies on every channel land in Action required, sorted, with a draft answer for your review."],
    next: null,
  };
}

/** Every step, in the order a new owner takes them. */
export function buildReadiness(facts: ReadinessFacts): ReadinessItem[] {
  const email = emailReadiness(facts);
  const linkedin = linkedinReadiness(facts);
  const whatsapp = whatsappReadiness(facts);
  return [
    workspaceReadiness(facts),
    email,
    linkedin,
    whatsapp,
    aiReadiness(facts),
    leadsReadiness(facts),
    campaignsReadiness(facts, { email, linkedin, whatsapp }),
    repliesReadiness(facts),
  ];
}
