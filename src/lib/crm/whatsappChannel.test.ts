import { describe, expect, test } from "bun:test";
import { classificationChannelNotes } from "./ai/classify";
import { buildDraftPrompt, draftChannelConstraints, draftJsonSchema, validateDraftOutput } from "./ai/draft";
import { callContextMessage } from "./callHistory";
import { CRM_CHANNELS, crmChannelHasSubject, crmChannelLabel, crmChannelSendProvider, isCrmChannel } from "./channels";
import { identityExceptionReplayInput } from "./identity";
import { whatsappOutreachRowToMessageInput, type WhatsappOutreachRow } from "./outreachHistory";
import type { crmIdentityExceptions } from "./schema";
import { WHATSAPP_NO_TEXT_BODY, whatsappCrmBodyText, whatsappCrmIdempotencyKey } from "@/lib/whatsapp/crmBridge";

describe("CRM channels", () => {
  test("whatsapp is a CRM channel with its own label, no subject, delivered by Unipile", () => {
    expect([...CRM_CHANNELS]).toEqual(["email", "linkedin", "whatsapp", "instagram", "browser"]);
    expect(isCrmChannel("whatsapp")).toBe(true);
    expect(isCrmChannel("sms")).toBe(false);
    expect(isCrmChannel(null)).toBe(false);
    expect(CRM_CHANNELS.map(crmChannelLabel)).toEqual(["Email", "LinkedIn", "WhatsApp", "Instagram", "Browser"]);
    expect(CRM_CHANNELS.map(crmChannelSendProvider)).toEqual(["gmail", "unipile", "unipile", "unipile", "browser"]);
    expect(CRM_CHANNELS.map(crmChannelHasSubject)).toEqual([true, false, false, false, false]);
  });
});

describe("WhatsApp drafts", () => {
  test("the model is told it is writing a short WhatsApp message with no subject or signature", () => {
    const constraints = draftChannelConstraints("whatsapp").join("\n");
    expect(constraints).toContain("WhatsApp");
    expect(constraints).toMatch(/subject as null/);
    expect(constraints).toMatch(/no signature block/);
    expect(constraints).toMatch(/short, conversational/);
    // Email and LinkedIn are unchanged.
    expect(draftChannelConstraints("linkedin")[0]).toBe("Return subject as null. LinkedIn drafts never have a subject.");
    expect(draftChannelConstraints("email")[0]).toBe("Return a non-empty subject and plain-text body.");
  });

  test("the schema and validation are subject-less and plain text", () => {
    const schema = draftJsonSchema("whatsapp") as { properties: { subject: { type: string }; bodyHtml: { type: string } } };
    expect(schema.properties.subject.type).toBe("null");
    expect(schema.properties.bodyHtml.type).toBe("null");
    expect(validateDraftOutput({ subject: null, bodyText: " Sure — Tuesday 4pm works? ", bodyHtml: null }, "whatsapp"))
      .toEqual({ subject: null, bodyText: "Sure — Tuesday 4pm works?", bodyHtml: null });
    expect(() => validateDraftOutput({ subject: "Hi", bodyText: "Hello", bodyHtml: null }, "whatsapp"))
      .toThrow(/WhatsApp draft subject must be null/);
    expect(() => validateDraftOutput({ subject: null, bodyText: "Hello", bodyHtml: "<p>Hello</p>" }, "whatsapp"))
      .toThrow(/WhatsApp draft bodyHtml must be null/);
    expect(() => validateDraftOutput({ subject: null, bodyText: "Hello", bodyHtml: null }, "sms" as never))
      .toThrow(/Unsupported CRM draft channel/);
  });

  test("the prompt names the channel and carries call summaries as context", () => {
    const call = callContextMessage({
      id: "call-1",
      startedAt: new Date("2026-09-01T10:00:00.000Z"),
      endedAt: new Date("2026-09-01T10:05:00.000Z"),
      createdAt: new Date("2026-09-01T09:59:00.000Z"),
      disposition: "interested",
      transcript: { summary: "They want pricing for 20 seats." },
    });
    expect(call).not.toBeNull();
    const prompt = buildDraftPrompt({
      channel: "whatsapp",
      sequenceStep: { name: "Reply", position: 1, stepType: "reply", aiInstructions: "Answer the question." },
      knowledge: [],
      person: { fullName: "Priya Rao" },
      recentConversation: [
        call!,
        { id: "m-1", channel: "whatsapp", direction: "inbound", sentAt: "2026-09-02T09:00:00.000Z", bodyText: "Can you send the pricing?" },
      ],
      acceptedClassification: { categoryKey: "interested", reasoning: "Asked for pricing" },
    });
    expect(prompt.snapshot.channel).toBe("whatsapp");
    expect(prompt.userPrompt).toContain("WhatsApp chat message");
    expect(prompt.userPrompt).toContain("They want pricing for 20 seats.");
    const conversation = prompt.snapshot.recentConversation as { id: string; channel: string }[];
    expect(conversation.map((message) => message.channel)).toEqual(["whatsapp_call", "whatsapp"]);
  });
});

describe("WhatsApp classification", () => {
  const base = {
    latestInboundMessage: { id: "m-1", channel: "email" as const, direction: "inbound" as const, sentAt: "2026-09-02T09:00:00.000Z", bodyText: "ok" },
    recentConversation: [],
  };

  test("email and LinkedIn prompts get no channel note", () => {
    expect(classificationChannelNotes(base)).toEqual([]);
    expect(classificationChannelNotes({ ...base, latestInboundMessage: { ...base.latestInboundMessage, channel: "linkedin" } })).toEqual([]);
  });

  test("a WhatsApp reply is explained as a chat message, and a call summary as background", () => {
    const notes = classificationChannelNotes({
      latestInboundMessage: { ...base.latestInboundMessage, channel: "whatsapp" },
      recentConversation: [{ id: "call:1", channel: "whatsapp_call", direction: "outbound", sentAt: "2026-09-01T09:00:00.000Z", bodyText: "Summary" }],
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/WhatsApp chat messages/);
    expect(notes[1]).toMatch(/background/);
  });

  test("a call transcript being classified itself is not called background", () => {
    const notes = classificationChannelNotes({
      latestInboundMessage: { ...base.latestInboundMessage, channel: "whatsapp_call" },
      recentConversation: [],
    });
    expect(notes).toEqual([]);
  });
});

describe("call context", () => {
  test("a call without a summary adds nothing", () => {
    expect(callContextMessage({
      id: "call-2", startedAt: null, endedAt: null, createdAt: new Date(), disposition: null, transcript: { summary: "  " },
    })).toBeNull();
    expect(callContextMessage({
      id: "call-3", startedAt: null, endedAt: null, createdAt: new Date(), disposition: null, transcript: null,
    })).toBeNull();
  });

  test("dates a call by when it ended and keys it apart from messages", () => {
    const createdAt = new Date("2026-09-01T09:00:00.000Z");
    const message = callContextMessage({
      id: "call-4", startedAt: null, endedAt: null, createdAt, disposition: null, transcript: { summary: "Asked to call back." },
    });
    expect(message).toMatchObject({ id: "call:call-4", channel: "whatsapp_call", sentAt: createdAt });
    expect(message?.bodyText).toContain("Asked to call back.");
  });
});

describe("WhatsApp history backfill", () => {
  const row = (overrides: Partial<WhatsappOutreachRow> = {}): WhatsappOutreachRow => ({
    id: "wa-row-1",
    unipileMessageId: "unipile-msg-1",
    body: "Hi Priya, following up on our call.",
    origin: "phone",
    sentAt: new Date("2026-09-01T10:10:00.000Z"),
    unipileChatId: "chat-1",
    crmConversationMessageId: null,
    ...overrides,
  });

  test("keys a rep's message the way the bridge does, so the two never duplicate", () => {
    const input = whatsappOutreachRowToMessageInput(row());
    expect(input).toMatchObject({
      direction: "outbound",
      idempotencyKey: whatsappCrmIdempotencyKey("unipile-msg-1"),
      providerMessageId: "unipile-msg-1",
      subject: null,
      bodyText: "Hi Priya, following up on our call.",
    });
  });

  test("skips the lead's messages, in-flight sends and empty bodies", () => {
    expect(whatsappOutreachRowToMessageInput(row({ origin: "lead" }))).toBeNull();
    expect(whatsappOutreachRowToMessageInput(row({ unipileMessageId: null }))).toBeNull();
    expect(whatsappOutreachRowToMessageInput(row({ body: "  " }))).toBeNull();
    // Already on a CRM conversation (sent from a CRM draft, or recorded by the bridge).
    expect(whatsappOutreachRowToMessageInput(row({ crmConversationMessageId: "crm-msg-1" }))).toBeNull();
  });
});

describe("WhatsApp bridge helpers", () => {
  test("a message with no text still reaches the CRM", () => {
    expect(whatsappCrmBodyText("  hello ")).toBe("hello");
    expect(whatsappCrmBodyText("   ")).toBe(WHATSAPP_NO_TEXT_BODY);
    expect(whatsappCrmIdempotencyKey("abc")).toBe("whatsapp:abc");
  });

  test("a quarantined WhatsApp reply replays onto the chosen Person", () => {
    type IdentityException = typeof crmIdentityExceptions.$inferSelect;
    const now = new Date("2026-09-02T12:00:00.000Z");
    const exception: IdentityException = {
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-0000-0000-00000000000a",
      channel: "whatsapp",
      accountRef: "wa-account-1",
      sourceEventKey: "whatsapp:unipile-msg-9",
      identityValue: "919876543210@s.whatsapp.net",
      reason: "Referenced canonical Person was not found",
      payload: {
        unipileChatId: "chat-9",
        providerContactId: "919876543210@s.whatsapp.net",
        unipileMessageId: "unipile-msg-9",
        body: "Yes, interested",
        sentAt: "2026-09-02T11:30:00.000Z",
      },
      status: "open",
      resolvedPersonId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const input = identityExceptionReplayInput(exception, "person-9");
    expect(input).toMatchObject({
      personId: "person-9",
      channel: "whatsapp",
      accountRef: "wa-account-1",
      providerThreadId: "chat-9",
      providerContactId: "919876543210@s.whatsapp.net",
      idempotencyKey: "whatsapp:unipile-msg-9",
      providerMessageId: "unipile-msg-9",
      bodyText: "Yes, interested",
    });
    expect(input.sentAt.toISOString()).toBe("2026-09-02T11:30:00.000Z");
  });
});
