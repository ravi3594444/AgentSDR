import { describe, expect, test } from "bun:test";
import { parseWriterReply, writerReplyInstructions, WRITER_REPLY_SCHEMAS } from "./writerReply";

const replies = {
  lead_sorting: { leads: [{ index: 25, group: "Real estate agencies", approach: "standard" as const, reason: "Offers real estate services in Chicago." }] },
  outreach_sequences: { channels: [{ channel: "email" as const, messages: [{ subject: "A question", body: "Do you handle inquiries manually?", waitDays: 0 }] }] },
  opening_lines: { lines: [{ index: 25, line: "I saw your Chicago office listed." }] },
  personal_messages: { messages: [{ index: 25, subject: "A question", body: "Do you handle inquiries manually?" }] },
  first_message_review: { messages: [{ channel: "email" as const, wouldReply: 4, reasons: [] }] },
};

describe("outreach response shapes", () => {
  for (const name of Object.keys(replies) as (keyof typeof replies)[]) {
    const reply = replies[name];
    const key = WRITER_REPLY_SCHEMAS[name].required[0]!;
    const rows = Object.values(reply)[0];

    test(`${name}: reads the canonical provider response`, () => {
      expect(parseWriterReply(JSON.stringify(reply), name)).toEqual(reply);
    });

    test(`${name}: recovers named wrappers and complete singleton rows`, () => {
      for (const value of [{ [name]: reply }, { [key]: rows[0] }, { [key]: JSON.stringify(rows) }, rows[0]]) {
        expect(parseWriterReply(JSON.stringify(value), name)).toEqual(reply);
      }
    });

    test(`${name}: missing or wrong arrays produce repair instructions instead of TypeErrors`, () => {
      for (const value of [{}, { message: "Done" }, { [key]: null }, { [key]: 7 }, { [key]: "not JSON" }, { [key]: [null] }]) {
        try {
          parseWriterReply(JSON.stringify(value), name);
          throw new Error("Invalid response was accepted");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(TypeError);
          expect((error as Error).message).toContain(name);
          expect((error as Error).message).toContain("required field");
        }
      }
      expect(writerReplyInstructions(name)).toContain(`"${key}" as an array`);
    });
  }

  test("nested channel message singleton objects are normalized too", () => {
    const channel = replies.outreach_sequences.channels[0]!;
    expect(parseWriterReply(JSON.stringify({ channels: { ...channel, messages: channel.messages[0] } }), "outreach_sequences"))
      .toEqual(replies.outreach_sequences);
  });

  test("the reported sorting crash is rejected before an unchecked leads iteration", () => {
    expect(() => parseWriterReply('{"message":"Sorted the leads."}', "lead_sorting"))
      .toThrow("lead_sorting.leads is required");
  });

  test("a bad field gives the exact row and field to repair", () => {
    for (const [field, value, reason] of [
      ["index", "25", "index must be an integer"],
      ["group", null, "group must be a string"],
      ["reason", 7, "reason must be a string"],
      ["approach", "send_now", "approach must be one of"],
    ] as const) {
      expect(() => parseWriterReply(JSON.stringify({ leads: [{ ...replies.lead_sorting.leads[0], [field]: value }] }), "lead_sorting"))
        .toThrow(`lead_sorting.leads[0].${reason}`);
    }
    expect(() => parseWriterReply('{"channels":[{"channel":"email","messages":[{"subject":"x","body":null,"waitDays":0}]}]}', "outreach_sequences"))
      .toThrow("outreach_sequences.channels[0].messages[0].body must be a string");
  });

  test("partial lead rows and numeric strings are never filled in or guessed", () => {
    expect(() => parseWriterReply('{"leads":{"index":25,"group":"Agencies"}}', "lead_sorting"))
      .toThrow("leads must be an array");
    expect(() => parseWriterReply('{"lines":[{"index":25,"line":null}]}', "opening_lines"))
      .toThrow("lines[0].line must be a string");
  });

  test("review scores outside the declared range are refused", () => {
    expect(() => parseWriterReply('{"messages":[{"channel":"email","wouldReply":10,"reasons":[]}]}', "first_message_review"))
      .toThrow("between 1 and 5");
  });

  test("the transport's non-object JSON cases stay invalid", () => {
    for (const value of [null, [], 7, "text"]) expect(() => parseWriterReply(JSON.stringify(value), "lead_sorting")).toThrow("must be an object");
    expect(() => parseWriterReply("not JSON", "lead_sorting")).toThrow("JSON object only");
  });
});
