import { describe, expect, test } from "bun:test";
import { classificationProposalChoices } from "./classificationProposal";

describe("held classification choices", () => {
  const choices = (currentCategoryKey: string | null, currentSubcategoryId: string | null, proposedCategoryKey: string | null, proposedSubcategoryId: string | null) => classificationProposalChoices({ currentCategoryKey, currentSubcategoryId, proposedCategoryKey, proposedSubcategoryId });
  test("Other to Other offers one confirmation for the same payload", () => {
    const result = choices("other", null, "other", null);
    expect(result.sameChoice).toBe(true);
    expect(result.accept).toEqual(result.keep);
  });
  test("different categories keep both explicit human choices", () => {
    const result = choices("interested", null, "other", null);
    expect(result.sameChoice).toBe(false);
    expect(result.keep.categoryKey).toBe("interested");
    expect(result.accept.categoryKey).toBe("other");
  });
  test("equal category labels cannot hide a different subcategory", () => {
    expect(choices("other", "current-subcategory", "other", "proposed-subcategory").sameChoice).toBe(false);
    expect(choices("other", "current-subcategory", "other", null).sameChoice).toBe(false);
    expect(choices("other", "same-subcategory", "other", "same-subcategory").sameChoice).toBe(true);
  });
  test("the legacy keep-Other fallback is also only one choice", () => {
    const result = choices(null, null, "other", null);
    expect(result.sameChoice).toBe(true);
    expect(result.keep).toEqual({ categoryKey: "other", subcategoryId: null });
  });
  test("a missing proposed category preserves the existing fallback", () => {
    const result = choices("interested", "current-subcategory", null, "ignored-subcategory");
    expect(result.sameChoice).toBe(true);
    expect(result.accept).toEqual({ categoryKey: "interested", subcategoryId: "current-subcategory" });
  });
});
