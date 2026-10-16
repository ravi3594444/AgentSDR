import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDraftPrompt,
  draftJsonSchema,
  generateCrmDraft,
  sanitizeProviderMetadata,
  validateDraftOutput,
  type DraftCompletion,
  type DraftCompletionInput,
  type GenerateCrmDraftInput,
} from "./draft";

function fixture(overrides: Partial<GenerateCrmDraftInput> = {}): GenerateCrmDraftInput {
  return {
    channel: "email",
    sequenceStep: {
      id: "step-1",
      name: "Answer demo request",
      purpose: "Answer the question and offer a demo time",
      position: 1,
      stepType: "reply",
      subjectTemplate: "Re: {{last_subject}}",
      bodyTemplate: "Hi {{first_name}}, ...",
      aiInstructions: "Be concise and propose the scheduling link.",
      knowledgeTags: ["scheduling", "product"],
    },
    knowledge: [{
      documentVersionId: "knowledge-version-2",
      documentId: "knowledge-1",
      title: "Scheduling",
      kind: "scheduling",
      excerpt: "Book a 30-minute demo at https://example.com/demo.",
      excerptHash: "sha256:example",
      rank: 1.25,
    }],
    person: {
      id: "person-1",
      fullName: "Priya Rao",
      email: "priya@example.com",
      attributes: { region: "India" },
    },
    company: { id: "company-1", name: "Example", domain: "example.com" },
    recentConversation: [{
      id: "message-1",
      channel: "email",
      direction: "inbound",
      sentAt: "2026-08-31T12:00:00.000Z",
      subject: "Demo",
      bodyText: "Can you show me the product this week?",
    }],
    acceptedClassification: {
      categoryKey: "interested",
      subcategoryKey: "demo_requested",
      reasoning: "The person explicitly requested a demo.",
    },
    mergeVariables: { last_subject: "Demo", first_name: "Priya" },
    requestedModel: { provider: "azure", modelId: "openai/gpt-5.2" },
    ...overrides,
  };
}

function completion(
  text: string,
  capture?: (input: DraftCompletionInput) => void,
): DraftCompletion {
  return async (input) => {
    capture?.(input);
    return {
      text,
      provider: "azure",
      model: "openai/gpt-5.2",
      request: {
        model: "openai/gpt-5.2",
        provider: { only: ["azure"], allow_fallbacks: false },
        authorization: "Bearer secret",
      },
      response: { id: "response-1", api_key: "secret" },
      usage: { inputTokens: 240, outputTokens: 70 },
    };
  };
}

describe("CRM draft prompt", () => {
  test("shows who else is on an email thread", () => {
    const input = fixture();
    const [message] = input.recentConversation;
    const prompt = buildDraftPrompt(fixture({
      recentConversation: [{ ...message!, participants: { from: "priya@example.com", to: ["me@us.com"], cc: ["boss@example.com"] } }],
    }));
    assert.match(prompt.userPrompt, /"cc": \[\s*"boss@example.com"\s*\]/);
    assert.doesNotMatch(buildDraftPrompt(fixture()).userPrompt, /"participants"/);
  });

  test("assembles every required source deterministically with human-send-only safety", () => {
    const first = buildDraftPrompt(fixture());
    const second = buildDraftPrompt(fixture({ mergeVariables: {
      first_name: "Priya",
      last_subject: "Demo",
    } }));

    assert.equal(first.userPrompt, second.userPrompt);
    assert.match(first.systemPrompt, /human-send-only/i);
    assert.match(first.systemPrompt, /Never send/i);
    assert.match(first.userPrompt, /Answer the question and offer a demo time/);
    assert.match(first.userPrompt, /knowledge-version-2/);
    assert.match(first.userPrompt, /Priya Rao/);
    assert.match(first.userPrompt, /Can you show me the product/);
    assert.match(first.userPrompt, /demo_requested/);
    assert.match(first.userPrompt, /first_name/);
  });

  test("a regeneration carries the rejected draft and the reviewer's feedback", () => {
    const plain = buildDraftPrompt(fixture());
    const revised = buildDraftPrompt(fixture({ revision: {
      previousDraft: { subject: "Re: Demo", bodyText: "Hi Priya, happy to show you around — here is a 60 minute slot." },
      reviewerFeedback: "Too long and too formal. Offer a 30 minute slot and drop the pleasantries.",
    } }));

    assert.doesNotMatch(plain.userPrompt, /revisionRequest/);
    assert.match(revised.userPrompt, /rejected the previous draft/);
    assert.match(revised.userPrompt, /do not return the previous draft again/);
    assert.match(revised.userPrompt, /here is a 60 minute slot/);
    assert.match(revised.userPrompt, /Offer a 30 minute slot/);
    assert.deepEqual((revised.snapshot.revisionRequest as { previousDraft: { subject: string } }).previousDraft.subject, "Re: Demo");
    assert.throws(() => buildDraftPrompt(fixture({ revision: {
      previousDraft: { subject: null, bodyText: "Some draft" },
      reviewerFeedback: "   ",
    } })), /reviewer feedback is required/i);
  });

  test("uses closed, channel-specific schemas", () => {
    const email = draftJsonSchema("email") as {
      additionalProperties: boolean;
      properties: { subject: { type: string } };
    };
    const linkedin = draftJsonSchema("linkedin") as {
      additionalProperties: boolean;
      properties: { subject: { type: string }; bodyHtml: { type: string } };
    };
    assert.equal(email.additionalProperties, false);
    assert.equal(email.properties.subject.type, "string");
    assert.equal(linkedin.additionalProperties, false);
    assert.equal(linkedin.properties.subject.type, "null");
    assert.equal(linkedin.properties.bodyHtml.type, "null");
  });
});

describe("CRM draft output validation", () => {
  test("requires an Email subject and body and rejects unknown fields", () => {
    assert.throws(() => validateDraftOutput("not-json", "email"), /malformed JSON/);
    assert.throws(() => validateDraftOutput(JSON.stringify({
      subject: "Hello",
      bodyText: "Body",
      bodyHtml: null,
      sendNow: true,
    }), "email"), /unknown field/);
    assert.throws(() => validateDraftOutput({ subject: null, bodyText: "Body", bodyHtml: null }, "email"), /subject is required/);
    assert.throws(() => validateDraftOutput({ subject: "Hello", bodyText: " ", bodyHtml: null }, "email"), /bodyText is required/);
  });

  test("requires a null or absent LinkedIn subject and plain-text-only body", () => {
    assert.throws(() => validateDraftOutput({ subject: "No", bodyText: "Hello", bodyHtml: null }, "linkedin"), /subject must be null or absent/);
    assert.throws(() => validateDraftOutput({ subject: null, bodyText: "Hello", bodyHtml: "<p>Hello</p>" }, "linkedin"), /bodyHtml must be null/);
    assert.deepEqual(
      validateDraftOutput({ bodyText: " Hello ", bodyHtml: null }, "linkedin"),
      { subject: null, bodyText: "Hello", bodyHtml: null },
    );
  });
});

describe("CRM draft generation boundary", () => {
  test("pins the requested model, returns draft data, and sanitizes audit metadata", async () => {
    let captured: DraftCompletionInput | undefined;
    const result = await generateCrmDraft(fixture(), {
      complete: completion(JSON.stringify({
        subject: "Re: Demo",
        bodyText: "Hi Priya, here is the demo link.",
        bodyHtml: null,
      }), (input) => { captured = input; }),
    });

    assert.deepEqual(captured?.requestedModel, { provider: "azure", modelId: "openai/gpt-5.2" });
    assert.equal(captured?.jsonSchema.additionalProperties, false);
    assert.equal(result.subject, "Re: Demo");
    assert.equal(result.bodyText, "Hi Priya, here is the demo link.");
    assert.equal(result.provider, "azure");
    assert.equal(result.model, "openai/gpt-5.2");
    assert.deepEqual(result.request, {
      model: "openai/gpt-5.2",
      provider: { allow_fallbacks: false, only: ["azure"] },
      replyContext: { messages: [{ direction: "inbound", bodyText: "Can you show me the product this week?" }] },
    });
    assert.deepEqual(result.response, { id: "response-1" });
    assert.equal("send" in result, false);
    assert.equal("sendNow" in result, false);
  });

  test("rejects a completion that did not honor exact provider/model pinning", async () => {
    const wrong: DraftCompletion = async () => ({
      text: JSON.stringify({ subject: "Hello", bodyText: "Body", bodyHtml: null }),
      provider: "other",
      model: "other/model",
      request: {},
      response: {},
    });
    await assert.rejects(
      () => generateCrmDraft(fixture(), { complete: wrong }),
      /did not use the requested provider and model/,
    );
  });

  test("metadata sanitizer removes nested transport secrets", () => {
    assert.deepEqual(sanitizeProviderMetadata({
      headers: { Authorization: "Bearer secret", "x-api-key": "secret", "x-trace": "trace-1" },
      credentials: { apiKey: "secret" },
      refreshToken: "secret",
    }), {
      headers: { "x-trace": "trace-1" },
    });
  });
});

describe("CRM draft stage change", () => {
  test("briefs the model on a stage a person moved the record to", () => {
    const prompt = buildDraftPrompt(fixture({
      stageChange: {
        stage: "Meeting Done",
        occurredAt: "2026-09-21T12:00:00.000Z",
        note: "  They want pricing for 50 seats.  ",
      },
    }));
    assert.deepEqual(prompt.snapshot.stageChange, {
      stage: "Meeting Done",
      occurredAt: "2026-09-21T12:00:00.000Z",
      note: "They want pricing for 50 seats.",
    });
    assert.match(prompt.userPrompt, /Meeting Done/);
    assert.match(prompt.systemPrompt, /stageChange/);
  });

  test("leaves the snapshot unchanged without one", () => {
    assert.equal("stageChange" in buildDraftPrompt(fixture()).snapshot, false);
    assert.equal("stageChange" in buildDraftPrompt(fixture({ stageChange: null })).snapshot, false);
  });
});

describe("CRM draft operator instructions", () => {
  test("appends them to the system prompt after the fixed rules", () => {
    const base = buildDraftPrompt(fixture());
    const prompt = buildDraftPrompt(fixture({ instructions: "  Sign off as Priya. Keep it under 120 words.  " }));
    assert.ok(prompt.systemPrompt.startsWith(base.systemPrompt));
    assert.match(prompt.systemPrompt, /<operator_instructions>\nSign off as Priya\. Keep it under 120 words\.\n<\/operator_instructions>$/);
    assert.match(prompt.systemPrompt, /do not override the rules above/);
    assert.equal(prompt.userPrompt, base.userPrompt);
  });

  test("leaves the system prompt unchanged when blank", () => {
    const base = buildDraftPrompt(fixture()).systemPrompt;
    assert.equal(buildDraftPrompt(fixture({ instructions: null })).systemPrompt, base);
    assert.equal(buildDraftPrompt(fixture({ instructions: "   " })).systemPrompt, base);
  });
});

describe("CRM draft grounding", () => {
  test("the prompt carries the sender and the record of completed actions", () => {
    const prompt = buildDraftPrompt(fixture({
      sender: { name: "Asha Rao", company: "22nd X AI", signature: "Asha Rao\nHead of Sales" },
      recentConversation: [
        { id: "m-0", channel: "email", direction: "outbound", sentAt: "2026-08-30T09:00:00.000Z", subject: "Pricing", bodyText: "Here is our pricing overview." },
        { id: "m-1", channel: "email", direction: "inbound", sentAt: "2026-08-31T12:00:00.000Z", subject: "Re: Pricing", bodyText: "Can we meet Tuesday?" },
      ],
    }));
    assert.deepEqual(prompt.snapshot.sender, { name: "Asha Rao", company: "22nd X AI", signature: "Asha Rao\nHead of Sales" });
    assert.deepEqual(prompt.snapshot.completedActions, [{
      kind: "message_sent",
      channel: "email",
      sentAt: "2026-08-30T09:00:00.000Z",
      subject: "Pricing",
      excerpt: "Here is our pricing overview.",
    }]);
    assert.match(prompt.systemPrompt, /never that it already happened/);
    assert.match(prompt.systemPrompt, /Never leave placeholders/);
  });

  test("an unknown sender is null, not a placeholder to fill in", () => {
    const prompt = buildDraftPrompt(fixture());
    assert.deepEqual(prompt.snapshot.sender, { name: null, company: null, signature: null });
  });

  test("an answer claiming a booked meeting or leaving [Your Name] is rejected inside the completion, then the grounded retry is kept", async () => {
    const answers = [
      { subject: "Re: Demo", bodyText: "Hi Priya, I've booked a demo for Thursday at 3pm.\n\nBest,\n[Your Name]", bodyHtml: null },
      { subject: "Re: Demo", bodyText: "Hi Priya, I've booked a demo for Thursday at 3pm.", bodyHtml: null },
      { subject: "Re: Demo", bodyText: "Hi Priya, would Thursday at 3pm work for a demo?", bodyHtml: null },
    ];
    const rejections: string[] = [];
    const retrying: DraftCompletion = async (input) => {
      for (const answer of answers) {
        const text = JSON.stringify(answer);
        try {
          input.accept?.(text);
          return { text, provider: "azure", model: "openai/gpt-5.2", request: {}, response: {} };
        } catch (error) {
          rejections.push((error as Error).message);
        }
      }
      throw new Error("no answer accepted");
    };
    const result = await generateCrmDraft(fixture(), { complete: retrying });
    assert.equal(result.bodyText, "Hi Priya, would Thursday at 3pm work for a demo?");
    assert.match(rejections[0]!, /placeholders/);
    assert.match(rejections[1]!, /Nothing has been booked/);
  });

  test("a completion that returns an ungrounded answer anyway fails visibly instead of being stored", async () => {
    await assert.rejects(
      () => generateCrmDraft(fixture(), { complete: completion(JSON.stringify({ subject: "Re: Demo", bodyText: "I've sent you the calendar invite.", bodyHtml: null })) }),
      /claims actions that completedActions does not record/,
    );
  });
});
