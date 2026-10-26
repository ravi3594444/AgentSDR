/** The two explicit human choices for a held AI classification. No classification is applied here. */
export function classificationProposalChoices(input: {
  currentCategoryKey: string | null | undefined;
  currentSubcategoryId: string | null | undefined;
  proposedCategoryKey: string | null | undefined;
  proposedSubcategoryId: string | null | undefined;
}) {
  const keep = { categoryKey: input.currentCategoryKey || "other", subcategoryId: input.currentSubcategoryId || null };
  const accept = input.proposedCategoryKey
    ? { categoryKey: input.proposedCategoryKey, subcategoryId: input.proposedSubcategoryId || null }
    : keep;
  return { keep, accept, sameChoice: accept.categoryKey === keep.categoryKey && accept.subcategoryId === keep.subcategoryId };
}
