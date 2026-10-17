import { describe, expect, test } from "bun:test";

import { isRecipientNotOnWhatsapp } from "./refusal";

const unipile =
  "Make sure that the recipient ID is valid and that the corresponding profile is not locked.";

describe("isRecipientNotOnWhatsapp", () => {
  test("recognises Unipile's recipient refusal", () => {
    expect(isRecipientNotOnWhatsapp(unipile)).toBe(true);
  });

  test("recognises it inside a longer detail", () => {
    expect(isRecipientNotOnWhatsapp(`Error: ${unipile} Contact support if this persists.`)).toBe(true);
  });

  test("recognises the profile wording on its own", () => {
    expect(isRecipientNotOnWhatsapp("profile is not locked")).toBe(true);
  });

  test("leaves unrelated refusals alone", () => {
    expect(isRecipientNotOnWhatsapp("The message text is too long")).toBe(false);
    expect(isRecipientNotOnWhatsapp("invalid account credentials")).toBe(false);
    expect(isRecipientNotOnWhatsapp(null)).toBe(false);
    expect(isRecipientNotOnWhatsapp("")).toBe(false);
  });
});
