import { describe, expect, test } from "bun:test";
import {
  aiReadiness,
  buildReadiness,
  campaignsReadiness,
  emailReadiness,
  linkedinReadiness,
  repliesReadiness,
  whatsappReadiness,
  workspaceReadiness,
  type ReadinessFacts,
} from "./readiness";

/** A brand-new workspace: an owner and nothing else. */
function fresh(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    workspace: { organizationName: "Acme", roleLabel: "Owner", members: 1, pendingInvitations: 0, authEmailConfigured: false },
    canManage: true,
    google: { connected: false, verifiedAt: null, replySyncTopicSet: false },
    mailboxes: { connected: 0, connecting: 0, failed: 0, disabled: 0 },
    unipile: { connected: false, verifiedAt: null, webhooks: null },
    linkedinAccounts: { connected: 0, disconnected: 0 },
    whatsappAccounts: { connected: 0, notConnected: 0 },
    ai: { provider: null, connectionSaved: false, connectionVerified: false, providers: 0, defaultModel: null, defaultModelEnabled: false, routingConfirmed: false },
    people: 0,
    campaigns: {
      email: { active: 0, paused: 0, draft: 0, completed: 0 },
      linkedin: { active: 0, paused: 0 },
      whatsapp: { active: 0, paused: 0 },
    },
    replies: { actionRequired: 0, draftsAwaitingReview: 0 },
    ...overrides,
  };
}

const googleOn = { connected: true, verifiedAt: "2026-10-13T08:00:00.000Z", replySyncTopicSet: true };
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
      replies: "clear",
    });
  });

  test("every step links only to pages that already exist", () => {
    const hrefs = buildReadiness(fresh()).flatMap((item) => item.links.map((link) => link.href));
    expect(new Set(hrefs)).toEqual(new Set([
      "/settings/organization",
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
      "/crm/actions",
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
        ...patch,
      },
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
        ...patch,
      },
    }));

  test("is ready without any BYOK routing confirmation", () => {
    const item = aiml({});
    expect(item.status).toBe("connected");
    expect(item.summary).toBe("Ready: openai/gpt-4o-mini through AI/ML API.");
    expect(item.details.join(" ")).toContain("Call transcription");
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
