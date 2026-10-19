import { describe, expect, test } from "bun:test";
import { mergedChatPatch } from "./chatMerge";

describe("mergedChatPatch", () => {
  test("a privacy-id chat the webhook stored keeps the number the send opened it with", () => {
    expect(mergedChatPatch({ personId: null, phone: null }, { personId: "p1", phone: "+919876543210" })).toEqual({ personId: "p1", phone: "+919876543210" });
  });
  test("what the stored chat already has is never overwritten", () => {
    expect(mergedChatPatch({ personId: "p2", phone: "+919800000000" }, { personId: "p1", phone: "+919876543210" })).toEqual({});
    expect(mergedChatPatch({ personId: "p2", phone: null }, { personId: "p1", phone: "+919876543210" })).toEqual({ phone: "+919876543210" });
  });
  test("nothing to carry, nothing written", () => {
    expect(mergedChatPatch({ personId: null, phone: null }, { personId: null, phone: null })).toEqual({});
  });
});
