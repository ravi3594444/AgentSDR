import { describe, expect, test } from "bun:test";
import { InstagramSendRefusedError, type DeliverInstagramInput, type DeliverInstagramResult } from "@/lib/instagram/delivery";
import { draftChannelConstraints, draftJsonSchema, validateDraftOutput } from "./ai/draft";
import { crmChannelHasSubject, crmChannelLabel, crmChannelSendProvider, isCrmChannel } from "./channels";
import { identityExceptionReplayInput } from "./identity";
import { instagramOutreachRowToMessageInput, type WhatsappOutreachRow } from "./outreachHistory";
import type { crmIdentityExceptions } from "./schema";
import { DefiniteCrmSendError, sendInstagramThroughCrm, sendThroughCrmProvider, type CrmSendAdapterInput } from "./send";

function request(overrides: Partial<CrmSendAdapterInput> = {}): CrmSendAdapterInput {
  return {
    channel: "instagram",
    accountRef: "ig-account-1",
    providerThreadId: "ig-chat-1",
    providerContactId: "ig-user-77",
    recipientEmail: null,
    recipientPhone: null,
    personId: "person-1",
    subject: null,
    bodyText: "Yes, we deliver to Baner. Want me to check Saturday?",
    bodyHtml: null,
    inReplyTo: null,
    ...overrides,
  };
}

function fakeDelivery() {
  const calls: DeliverInstagramInput[] = [];
  const deliver = async (input: DeliverInstagramInput): Promise<DeliverInstagramResult> => {
    calls.push(input);
    return { unipileChatId: input.unipileChatId!, unipileMessageId: "ig-msg-9", instagramMessageId: "ig-row-1" };
  };
  return { calls, deliver };
}

describe("Instagram as a CRM channel", () => {
  test("has its own label, no subject, and is delivered by Unipile", () => {
    expect(isCrmChannel("instagram")).toBe(true);
    expect(crmChannelLabel("instagram")).toBe("Instagram");
    expect(crmChannelHasSubject("instagram")).toBe(false);
    expect(crmChannelSendProvider("instagram")).toBe("unipile");
  });

  test("drafts are short direct messages with no subject or HTML", () => {
    const schema = draftJsonSchema("instagram") as { properties: Record<string, unknown> };
    expect(schema.properties.subject).toEqual({ type: "null" });
    expect(schema.properties.bodyHtml).toEqual({ type: "null" });
    const constraints = draftChannelConstraints("instagram").join("\n");
    expect(constraints).toContain("Instagram direct message");
    expect(constraints).toContain("never have a subject");
    expect(validateDraftOutput({ subject: null, bodyText: " Sure! ", bodyHtml: null }, "instagram")).toEqual({ subject: null, bodyText: "Sure!", bodyHtml: null });
    expect(() => validateDraftOutput({ subject: "Re: hi", bodyText: "Sure", bodyHtml: null }, "instagram")).toThrow("Instagram draft subject");
  });

  test("a quarantined Instagram message replays as an Instagram reply, not as email", () => {
    const exception = {
      channel: "instagram",
      accountRef: "ig-account-1",
      sourceEventKey: "instagram:msg-1",
      identityValue: "ig-user-77",
      createdAt: new Date("2026-10-16T08:00:00Z"),
      payload: { unipileChatId: "ig-chat-1", providerContactId: "ig-user-77", unipileMessageId: "msg-1", body: "Do you deliver?", sentAt: "2026-10-16T07:59:00Z" },
    } as unknown as typeof crmIdentityExceptions.$inferSelect;
    expect(identityExceptionReplayInput(exception, "person-1")).toMatchObject({
      personId: "person-1",
      channel: "instagram",
      providerThreadId: "ig-chat-1",
      providerMessageId: "msg-1",
      bodyText: "Do you deliver?",
    });
  });

  test("history backfill copies only what the owner sent, keyed instagram:<id>", () => {
    const row: WhatsappOutreachRow = { id: "r1", unipileMessageId: "m1", body: "Hi! Thanks for following.", origin: "phone", sentAt: new Date(), unipileChatId: "c1", crmConversationMessageId: null };
    expect(instagramOutreachRowToMessageInput(row)).toMatchObject({ direction: "outbound", idempotencyKey: "instagram:m1", providerMessageId: "m1" });
    expect(instagramOutreachRowToMessageInput({ ...row, origin: "lead" })).toBeNull();
    expect(instagramOutreachRowToMessageInput({ ...row, crmConversationMessageId: "already" })).toBeNull();
  });
});

describe("CRM send over Instagram", () => {
  test("replies into the conversation's chat from its account and normalizes the result", async () => {
    const { calls, deliver } = fakeDelivery();
    const result = await sendInstagramThroughCrm(request(), deliver);
    expect(calls).toEqual([{ unipileAccountId: "ig-account-1", unipileChatId: "ig-chat-1", text: "Yes, we deliver to Baner. Want me to check Saturday?", personId: "person-1" }]);
    expect(result).toEqual({
      provider: "unipile",
      providerMessageId: "ig-msg-9",
      providerThreadId: "ig-chat-1",
      rfcMessageId: null,
      response: { messageId: "ig-msg-9", chatId: "ig-chat-1", instagramMessageId: "ig-row-1" },
    });
  });

  test("never starts a new chat: without one it fails definitely and calls nothing", async () => {
    const { calls, deliver } = fakeDelivery();
    await expect(sendInstagramThroughCrm(request({ providerThreadId: null }), deliver)).rejects.toBeInstanceOf(DefiniteCrmSendError);
    expect(calls).toHaveLength(0);
  });

  test("a refusal is a definite failure, not an uncertain delivery", async () => {
    const deliver = async (): Promise<DeliverInstagramResult> => {
      throw new InstagramSendRefusedError("do_not_contact", "This person is marked Do Not Contact");
    };
    await expect(sendInstagramThroughCrm(request(), deliver)).rejects.toThrow(DefiniteCrmSendError);
  });

  test("the provider dispatcher never sends an Instagram reply as a LinkedIn message", async () => {
    // With no Instagram sender wired up, the dispatcher must refuse definitely
    // rather than fall through to the LinkedIn branch (which would send the
    // text to whatever LinkedIn chat has this id).
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("no network in tests");
    }) as unknown as typeof fetch;
    try {
      await expect(sendThroughCrmProvider(request())).rejects.toBeInstanceOf(Error);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
