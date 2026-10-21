import { describe, expect, test } from "bun:test";
import {
  aiReadiness,
  buildReadiness,
  campaignsReadiness,
  emailReadiness,
  linkedinReadiness,
  repliesReadiness,
  replySyncReadiness,
  whatsappReadiness,
  workspaceReadiness,
  type ReadinessFacts,
} from "./readiness";

/** A brand-new workspace: an owner and nothing else. */
function fresh(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    workspace: { organizationName: "Acme", roleLabel: "Owner", members: 1, pendingInvitations: 0, authEmailConfigured: false },
    canManage: true,
    google: { connected: false, verifiedAt: null, replySyncTopicSet: false, gmailWatch: null },
    mailboxes: { connected: 0, connecting: 0, failed: 0, disabled: 0 },
    unipile: { connected: false, verifiedAt: null, webhooks: null },
    linkedinAccounts: { connected: 0, disconnected: 0 },
    whatsappAccounts: { connected: 0, notConnected: 0 },
    ai: { provider: null, connectionSaved: false, connectionVerified: false, providers: 0, defaultModel: null, defaultModelEnabled: false, routingConfirmed: false, researchModel: null },
    people: 0,
    campaigns: {
      email: { active: 0, paused: 0, draft: 0, completed: 0 },
      linkedin: { active: 0, paused: 0 },
      whatsapp: { active: 0, paused: 0 },
    },
    replies: { actionRequired: 0, draftsAwaitingReview: 0 },
    traffic: {
      email: { lastSentAt: null, lastReplyAt: null },
      linkedin: { lastSentAt: null, lastReplyAt: null },
      whatsapp: { lastSentAt: null, lastReplyAt: null },
    },
    ...overrides,
  };
}

const googleOn = {
  connected: true,
  verifiedAt: "2026-10-13T08:00:00.000Z",
  replySyncTopicSet: true,
  gmailWatch: { status: "registered" as const, at: "2026-10-13T08:01:00.000Z", registered: 1, attempted: 1 },
};
const unipileOn = { connected: true, verifiedAt: "2026-10-13T08:00:00.000Z", webhooks: { status: "registered" as const } };

describe("a fresh workspace", () => {
  test("claims nothing it has no evidence for", () => {
    const statuses = Object.fromEntries(buildReadiness(fresh()).map((item) => [item.key, item.status]));
    expect(statuses).toEqual({
      workspace: "done",
      email: "not_configured",
      linkedin: "not_configured",
      whatsapp: "not_configured",
      ai: "not_configured",
      leads: "to_do",
      campaigns: "to_do",
      replySync: "not_configured",
      replies: "clear",
    });
  });

  test("every step links only to pages that already exist", () => {
    const hrefs = buildReadiness(fresh()).flatMap((item) => item.links.map((link) => link.href));
    expect(new Set(hrefs)).toEqual(new Set([
      "/settings/business",
      "/settings/members",
      "/settings/email-connection",
      "/settings/email-accounts",
      "/settings/email-rules",
      "/settings/linkedin-connection",
      "/settings/linkedin-accounts",
      "/settings/linkedin-rules",
      "/settings/whatsapp-connection",
      "/settings/whatsapp-accounts",
      "/settings/whatsapp-rules",
      "/settings/ai",
      "/leads",
      "/outreach/campaigns",
      "/linkedin/campaigns",
      "/whatsapp/campaigns",
      "/inbox",
    ]));
  });

  test("says when invitation email is only logged", () => {
    expect(workspaceReadiness(fresh()).next).toContain("RESEND_API_KEY");
    expect(workspaceReadiness(fresh({ workspace: { ...fresh().workspace, authEmailConfigured: true } })).next).toBeNull();
  });
});

describe("email readiness", () => {
  test("connected credentials without a mailbox are not yet verified", () => {
    expect(emailReadiness(fresh({ google: googleOn })).status).toBe("not_verified");
  });

  test("a mailbox without a Pub/Sub topic needs attention: replies would not stop follow-ups", () => {
    const item = emailReadiness(fresh({ google: { ...googleOn, replySyncTopicSet: false }, mailboxes: { connected: 1, connecting: 0, failed: 0, disabled: 0 } }));
    expect(item.status).toBe("needs_attention");
    expect(item.summary).toContain("replies are not picked up");
  });

  test("a failed mailbox outranks everything else", () => {
    const item = emailReadiness(fresh({ google: googleOn, mailboxes: { connected: 2, connecting: 0, failed: 1, disabled: 0 } }));
    expect(item.status).toBe("needs_attention");
    expect(item.summary).toBe("1 mailbox failed the last check.");
  });

  test("connected only with a connected mailbox and reply sync", () => {
    const item = emailReadiness(fresh({ google: googleOn, mailboxes: { connected: 1, connecting: 0, failed: 0, disabled: 0 } }));
    expect(item.status).toBe("connected");
    expect(item.details[0]).toBe("Credentials passed a live check on 2026-10-13.");
  });
});

describe("LinkedIn and WhatsApp readiness", () => {
  test("both depend on the one Unipile connection", () => {
    expect(linkedinReadiness(fresh()).status).toBe("not_configured");
    expect(whatsappReadiness(fresh()).status).toBe("not_configured");
  });

  test("failed webhook registration needs attention on both", () => {
    const facts = fresh({ unipile: { ...unipileOn, webhooks: { status: "failed", message: "401 from Unipile" } }, linkedinAccounts: { connected: 1, disconnected: 0 } });
    expect(linkedinReadiness(facts).status).toBe("needs_attention");
    expect(linkedinReadiness(facts).details).toContain("401 from Unipile");
    expect(whatsappReadiness(facts).status).toBe("needs_attention");
  });

  test("no linked account is not yet verified", () => {
    expect(linkedinReadiness(fresh({ unipile: unipileOn })).status).toBe("not_verified");
    expect(whatsappReadiness(fresh({ unipile: unipileOn })).next).toContain("Sync from Unipile");
  });

  test("webhooks skipped on a local address keep an account from counting as connected", () => {
    const item = linkedinReadiness(fresh({
      unipile: { ...unipileOn, webhooks: { status: "skipped", message: "Not registered for http://localhost:3000" } },
      linkedinAccounts: { connected: 1, disconnected: 0 },
    }));
    expect(item.status).toBe("not_verified");
    expect(item.next).toContain("public HTTPS address");
  });

  test("a disconnected account needs attention", () => {
    const item = linkedinReadiness(fresh({ unipile: unipileOn, linkedinAccounts: { connected: 1, disconnected: 1 } }));
    expect(item.status).toBe("needs_attention");
  });

  test("connected with a linked account and registered webhooks", () => {
    expect(linkedinReadiness(fresh({ unipile: unipileOn, linkedinAccounts: { connected: 2, disconnected: 0 } })).status).toBe("connected");
    expect(whatsappReadiness(fresh({ unipile: unipileOn, whatsappAccounts: { connected: 1, notConnected: 0 } })).status).toBe("connected");
  });
});

describe("AI readiness follows the runtime gate", () => {
  const ai = (patch: Partial<ReadinessFacts["ai"]>) =>
    aiReadiness(fresh({
      ai: {
        provider: "openrouter",
        connectionSaved: true,
        connectionVerified: true,
        providers: 1,
        defaultModel: { provider: "anthropic", modelId: "anthropic/claude-sonnet" },
        defaultModelEnabled: true,
        routingConfirmed: true,
        researchModel: null,
        ...patch,
      } as ReadinessFacts["ai"],
    }));

  test("each missing step is named, in the order it is fixed", () => {
    expect(ai({ provider: null, connectionSaved: false }).summary).toBe("No AI provider is connected.");
    expect(ai({ connectionVerified: false }).status).toBe("needs_attention");
    expect(ai({ providers: 0 }).summary).toContain("no BYOK provider");
    expect(ai({ defaultModelEnabled: false }).summary).toContain("default model");
    expect(ai({ routingConfirmed: false }).summary).toContain("BYOK-only routing is not confirmed");
  });

  test("ready only when every step passes", () => {
    const item = ai({});
    expect(item.status).toBe("connected");
    expect(item.summary).toBe("Ready: anthropic/claude-sonnet through anthropic.");
  });
});

describe("AI readiness with AI/ML API", () => {
  const aiml = (patch: Partial<ReadinessFacts["ai"]>) =>
    aiReadiness(fresh({
      ai: {
        provider: "aimlapi",
        connectionSaved: true,
        connectionVerified: true,
        providers: 1,
        defaultModel: { provider: "aimlapi", modelId: "openai/gpt-4o-mini" },
        defaultModelEnabled: true,
        routingConfirmed: false,
        researchModel: null,
        ...patch,
      } as ReadinessFacts["ai"],
    }));

  test("is ready without any BYOK routing confirmation", () => {
    const item = aiml({});
    expect(item.status).toBe("connected");
    expect(item.summary).toBe("Ready: openai/gpt-4o-mini through AI/ML API.");
    expect(item.details.join(" ")).toContain("Web research about companies is off");
    expect(aiml({ researchModel: "perplexity/sonar" }).details.join(" ")).toContain("Web research about companies uses perplexity/sonar");
  });

  test("names AI/ML API's own steps, never OpenRouter's", () => {
    expect(aiml({ connectionVerified: false }).summary).toBe("The saved AI/ML API key did not pass verification.");
    expect(aiml({ providers: 0 }).summary).toBe("AI/ML API is connected, but no model is selected.");
    expect(aiml({ defaultModelEnabled: false }).summary).toBe("AI/ML API is connected, but no usable default model is chosen.");
    for (const item of [aiml({ connectionVerified: false }), aiml({ providers: 0 }), aiml({ defaultModel: null })]) {
      expect(`${item.summary} ${item.next}`).not.toMatch(/BYOK|management key|routing/);
    }
  });
});

describe("outreach steps", () => {
  test("an active campaign on a channel that is not connected needs attention", () => {
    const facts = fresh({ campaigns: { ...fresh().campaigns, email: { active: 1, paused: 0, draft: 0, completed: 0 } } });
    const items = buildReadiness(facts);
    const campaigns = items.find((item) => item.key === "campaigns")!;
    expect(campaigns.status).toBe("needs_attention");
    expect(campaigns.summary).toContain("email");
  });

  test("campaigns on connected channels are done", () => {
    const facts = fresh({
      unipile: unipileOn,
      linkedinAccounts: { connected: 1, disconnected: 0 },
      campaigns: { ...fresh().campaigns, linkedin: { active: 1, paused: 1 } },
    });
    const item = campaignsReadiness(facts, { email: emailReadiness(facts), linkedin: linkedinReadiness(facts), whatsapp: whatsappReadiness(facts) });
    expect(item.status).toBe("done");
    expect(item.details).toContain("LinkedIn: 1 active · 1 paused.");
  });

  test("waiting replies and drafts need attention", () => {
    const item = repliesReadiness(fresh({ replies: { actionRequired: 2, draftsAwaitingReview: 1 } }));
    expect(item.status).toBe("needs_attention");
    expect(item.summary).toBe("2 conversations need action · 1 draft awaiting review.");
  });
});

describe("roles", () => {
  test("a member is told that integration steps need an owner or admin", () => {
    expect(emailReadiness(fresh({ canManage: false })).next).toContain("Only an owner or admin");
    expect(aiReadiness(fresh({ canManage: false })).next).toContain("Only an owner or admin");
    expect(emailReadiness(fresh()).next).not.toContain("Only an owner or admin");
  });
});

describe("Gmail watch and incoming replies", () => {
  const emailReady = { google: googleOn, mailboxes: { connected: 1, connecting: 0, failed: 0, disabled: 0 } };

  test("a topic alone is not enough: the watch must have been registered", () => {
    expect(emailReadiness(fresh({ ...emailReady, google: { ...googleOn, gmailWatch: null } })).status).toBe("not_verified");
    expect(emailReadiness(fresh(emailReady)).status).toBe("connected");
  });

  test("a failed or partial watch needs attention and says why", () => {
    const failed = emailReadiness(fresh({ ...emailReady, google: { ...googleOn, gmailWatch: { status: "failed", at: "2026-10-13T08:01:00.000Z", registered: 0, attempted: 1, message: "sales@x.com: topic not found" } } }));
    expect(failed.status).toBe("needs_attention");
    expect(failed.details.join(" ")).toContain("topic not found");
    const partial = emailReadiness(fresh({ ...emailReady, google: { ...googleOn, gmailWatch: { status: "partial", at: "2026-10-13T08:01:00.000Z", registered: 1, attempted: 2 } } }));
    expect(partial.summary).toContain("1 of 2");
  });

  test("a connected channel is proven only by a reply that actually arrived", () => {
    const facts = fresh({ ...emailReady, unipile: unipileOn, linkedinAccounts: { connected: 1, disconnected: 0 } });
    const channels = { email: emailReadiness(facts), linkedin: linkedinReadiness(facts), whatsapp: whatsappReadiness(facts) };
    const unproven = replySyncReadiness(facts, channels);
    expect(unproven.status).toBe("to_do");
    expect(unproven.summary).toBe("Not proven yet on Email, LinkedIn: no reply has arrived there.");

    const proven = replySyncReadiness({
      ...facts,
      traffic: {
        email: { lastSentAt: "2026-10-12T09:00:00.000Z", lastReplyAt: "2026-10-12T10:00:00.000Z" },
        linkedin: { lastSentAt: null, lastReplyAt: "2026-10-12T11:00:00.000Z" },
        whatsapp: { lastSentAt: null, lastReplyAt: null },
      },
    }, channels);
    expect(proven.status).toBe("done");
    expect(proven.details).toEqual(["Email: last reply received 2026-10-12.", "LinkedIn: last reply received 2026-10-12."]);
  });
});

describe("email through Unipile (no Google Workspace)", () => {
  const unipileEmail = { ...unipileOn, emailWebhook: true };
  const oneUnipileMailbox = { connected: 1, connecting: 0, failed: 0, disabled: 0, unipileConnected: 1 };

  test("neither provider connected names both ways to send", () => {
    const item = emailReadiness(fresh());
    expect(item.status).toBe("not_configured");
    expect(item.next).toContain("Google Workspace or Unipile");
  });

  test("Unipile connected without a synced inbox asks for Sync from Unipile", () => {
    const item = emailReadiness(fresh({ unipile: unipileEmail }));
    expect(item.status).toBe("not_verified");
    expect(item.next).toContain("Sync from Unipile");
  });

  test("a Unipile mailbox without the email webhook sends but cannot hear replies", () => {
    const item = emailReadiness(fresh({ unipile: unipileOn, mailboxes: oneUnipileMailbox }));
    expect(item.status).toBe("needs_attention");
    expect(item.summary).toContain("replies are not picked up");
  });

  test("a Unipile mailbox with the email webhook is connected, no Gmail topic needed", () => {
    const item = emailReadiness(fresh({ unipile: unipileEmail, mailboxes: oneUnipileMailbox }));
    expect(item.status).toBe("connected");
    expect(item.summary).toContain("through Unipile");
  });

  test("Google Workspace mailboxes keep the Gmail rules even when Unipile is connected", () => {
    const item = emailReadiness(fresh({
      google: { ...googleOn, replySyncTopicSet: false },
      unipile: unipileEmail,
      mailboxes: { connected: 2, connecting: 0, failed: 0, disabled: 0, unipileConnected: 1 },
    }));
    expect(item.status).toBe("needs_attention");
    expect(item.next).toContain("Gmail Pub/Sub topic");
  });
});

describe("Instagram in Getting started", () => {
  test("no step while the organization has Instagram off", () => {
    expect(buildReadiness(fresh()).some((item) => item.key === "instagram")).toBe(false);
    expect(buildReadiness(fresh({ instagram: null })).some((item) => item.key === "instagram")).toBe(false);
  });

  test("with Instagram on, the step reads Unipile, the outbound tables and the accounts", () => {
    const step = (instagram: NonNullable<ReadinessFacts["instagram"]>, unipile = true) =>
      buildReadiness(fresh({ instagram, unipile: { ...fresh().unipile, connected: unipile } })).find((item) => item.key === "instagram")!;
    expect(step({ ready: true, connected: 1, notConnected: 0 }, false).status).toBe("not_configured");
    expect(step({ ready: false, connected: 1, notConnected: 0 }).status).toBe("needs_attention");
    expect(step({ ready: true, connected: 0, notConnected: 1 }).summary).toBe("1 Instagram account not connected.");
    expect(step({ ready: true, connected: 0, notConnected: 0 }).status).toBe("not_verified");
    const ok = step({ ready: true, connected: 2, notConnected: 0 });
    expect(ok.status).toBe("connected");
    expect(ok.links.map((link) => link.href)).toEqual(["/settings/instagram-accounts", "/settings/instagram-rules"]);
  });

  test("it sits with the other channels, after WhatsApp", () => {
    const keys = buildReadiness(fresh({ instagram: { ready: true, connected: 1, notConnected: 0 } })).map((item) => item.key);
    expect(keys.indexOf("instagram")).toBe(keys.indexOf("whatsapp") + 1);
  });
});
