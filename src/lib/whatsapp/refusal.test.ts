import { describe, expect, test } from "bun:test";

import { isWhatsappRecipientRefusal } from "./refusal";

const unipile =
  "Make sure that the recipient ID is valid and that the corresponding profile is not locked.";

describe("isWhatsappRecipientRefusal", () => {
  test("recognises Unipile's recipient refusal", () => {
    expect(isWhatsappRecipientRefusal(422, unipile)).toBe(true);
  });

  test("recognises it inside a longer detail", () => {
    expect(
      isWhatsappRecipientRefusal(
        422,
        `Error: ${unipile} Contact support if this persists.`,
      ),
    ).toBe(true);
  });

  test("recognises the profile wording on its own", () => {
    expect(isWhatsappRecipientRefusal(422, "profile is not locked")).toBe(true);
  });

  test("leaves unrelated refusals alone", () => {
    expect(
      isWhatsappRecipientRefusal(422, "The message text is too long"),
    ).toBe(false);
    expect(isWhatsappRecipientRefusal(422, "invalid account credentials")).toBe(
      false,
    );
    expect(isWhatsappRecipientRefusal(422, null)).toBe(false);
    expect(isWhatsappRecipientRefusal(422, "")).toBe(false);
  });
});

test("does not turn account, rate-limit or uncertain failures into recipient refusals", () => {
  for (const status of [401, 403, 408, 409, 429, 500, 502, null]) {
    expect(isWhatsappRecipientRefusal(status, unipile)).toBe(false);
  }
  for (const status of [400, 404, 422])
    expect(isWhatsappRecipientRefusal(status, unipile)).toBe(true);
});
