import { describe, expect, test } from "bun:test";
import { isAcknowledgementOnly, isBareGreeting } from "./greeting";

describe("a bare greeting or acknowledgement", () => {
  test("greetings, thanks and acknowledgements, in English and Hinglish, are not intent", () => {
    for (const text of ["Hey", "hi", "Hello Ravi", "Hey there!", "Hii 👋", "ok", "Ok thanks", "Thank you", "Yeah thats cool", "theek hai", "Haan ji", "Good morning sir", "👍", "noted.", "Sounds good"]) {
      expect(isBareGreeting(text)).toBe(true);
    }
  });

  test("an acknowledgement needs no answer after ours; a greeting always does", () => {
    for (const text of ["ok", "Ok thanks", "Thank you!", "noted", "👍", "theek hai"]) expect(isAcknowledgementOnly(text)).toBe(true);
    for (const text of ["Hey", "Hey bro", "Hi Ravi", "Hello", "Good morning", "Hi, ok"]) expect(isAcknowledgementOnly(text)).toBe(false);
  });

  test("anything that asks or tells is a real message", () => {
    for (const text of ["Hey, how much is it?", "Hi, what do you offer", "Please call me", "We have 3 chairs", "Yes, let's book a call", "Stop messaging me", "Kitna lagega", "Hello, I run a clinic in Baner"]) {
      expect(isBareGreeting(text)).toBe(false);
    }
  });
});
