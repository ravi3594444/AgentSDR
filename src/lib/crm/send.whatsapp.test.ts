import { describe, expect, test } from "bun:test";
import { WhatsappSendRefusedError, type DeliverWhatsappInput, type DeliverWhatsappResult } from "@/lib/whatsapp/delivery";
import { DefiniteCrmSendError, DeferredCrmSendError, sendWhatsappThroughCrm, type CrmSendAdapterInput } from "./send";

function request(overrides: Partial<CrmSendAdapterInput> = {}): CrmSendAdapterInput {
  return {
    channel: "whatsapp",
    accountRef: "wa-account-1",
    providerThreadId: "chat-1",
    providerContactId: "919876543210@s.whatsapp.net",
    recipientEmail: "priya@example.com",
    recipientPhone: "+919876543210",
    subject: null,
    bodyText: "Sure — Tuesday 4pm?",
    bodyHtml: null,
    inReplyTo: null,
    ...overrides,
  };
}

function fakeDelivery(result: Partial<DeliverWhatsappResult> = {}) {
  const calls: DeliverWhatsappInput[] = [];
  const deliver = async (input: DeliverWhatsappInput): Promise<DeliverWhatsappResult> => {
    calls.push(input);
    return { unipileChatId: input.unipileChatId ?? "new-chat", unipileMessageId: "unipile-msg-1", whatsappMessageId: "wa-row-1", ...result };
  };
  return { calls, deliver };
}

describe("CRM send over WhatsApp", () => {
  test("sends into the conversation's chat from its account and normalizes the result", async () => {
    const { calls, deliver } = fakeDelivery();
    const result = await sendWhatsappThroughCrm(request(), deliver);
    expect(calls).toEqual([{ unipileAccountId: "wa-account-1", unipileChatId: "chat-1", phone: "+919876543210", text: "Sure — Tuesday 4pm?" }]);
    expect(result).toEqual({
      provider: "unipile",
      providerMessageId: "unipile-msg-1",
      providerThreadId: "chat-1",
      rfcMessageId: null,
      response: { messageId: "unipile-msg-1", chatId: "chat-1", whatsappMessageId: "wa-row-1" },
    });
  });

  test("without a chat, sends to the Person's number and reports the chat it opened", async () => {
    const { calls, deliver } = fakeDelivery({ unipileChatId: "opened-chat" });
    const result = await sendWhatsappThroughCrm(request({ providerThreadId: null }), deliver);
    expect(calls[0]).toMatchObject({ unipileChatId: null, phone: "+919876543210" });
    expect(result.providerThreadId).toBe("opened-chat");
  });

  test("with neither a chat nor a phone, fails definitely without calling WhatsApp", async () => {
    const { calls, deliver } = fakeDelivery();
    await expect(sendWhatsappThroughCrm(request({ providerThreadId: null, recipientPhone: "  " }), deliver))
      .rejects.toBeInstanceOf(DefiniteCrmSendError);
    expect(calls).toHaveLength(0);
  });

  test("a guardrail refusal is a definite failure, not an uncertain delivery", async () => {
    const deliver = async (): Promise<DeliverWhatsappResult> => {
      throw new WhatsappSendRefusedError("This number is still warming up", 409);
    };
    const error = await sendWhatsappThroughCrm(request(), deliver).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DefiniteCrmSendError);
    expect((error as Error).message).toBe("This number is still warming up");
  });

  test("any other failure is passed through for sendDraft to judge", async () => {
    const network = new Error("socket hang up");
    const deliver = async (): Promise<DeliverWhatsappResult> => {
      throw network;
    };
    const error = await sendWhatsappThroughCrm(request(), deliver).catch((caught: unknown) => caught);
    expect(error).toBe(network);
  });

  test("the local sender gap is a timed deferral, with no provider submission to reconcile", async () => {
    const before = Date.now();
    const deliver = async (): Promise<DeliverWhatsappResult> => {
      throw new WhatsappSendRefusedError("Wait 25 seconds between sends", 429, 25, "send_gap");
    };
    const error = await sendWhatsappThroughCrm(request(), deliver).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeferredCrmSendError);
    expect(error).toBeInstanceOf(DefiniteCrmSendError);
    expect((error as DeferredCrmSendError).retryAt.getTime()).toBeGreaterThanOrEqual(before + 25_000);
    expect((error as DeferredCrmSendError).retryAt.getTime()).toBeLessThanOrEqual(Date.now() + 25_000);
  });

  test("provider rate limits and disconnected accounts are not mistaken for a local spacing wait", async () => {
    for (const refusal of [
      new WhatsappSendRefusedError("Provider rate limit", 429, 60, "rate_limited"),
      new WhatsappSendRefusedError("Not connected", 409, null, "not_connected"),
      new WhatsappSendRefusedError("Invalid wait", 429, Number.NaN, "send_gap"),
    ]) {
      const error = await sendWhatsappThroughCrm(request(), async () => { throw refusal; }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DefiniteCrmSendError);
      expect(error).not.toBeInstanceOf(DeferredCrmSendError);
    }
  });

  test("refuses a non-WhatsApp request", async () => {
    const { deliver } = fakeDelivery();
    await expect(sendWhatsappThroughCrm(request({ channel: "linkedin" }), deliver)).rejects.toThrow(/Not a WhatsApp send/);
  });
});
