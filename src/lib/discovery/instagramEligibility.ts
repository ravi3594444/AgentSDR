/**
 * Whether an Instagram account a search found is a qualified lead for
 * Instagram outreach. An Instagram-only account (no email or phone) is
 * reachable by DM through the organization's connected Unipile account once
 * an outreach plan is approved, so having no other route never excludes it.
 * What it needs, as every social profile does: its identity read from its own
 * profile, and, for a search in a place, that profile or the post naming the
 * place (a hashtag alone does not place an account). An account that misses
 * either is kept for further research, with the reason, and is not contacted.
 * Eligibility is not permission: the plan's authorization, Do Not Contact,
 * account health and the sending limits still decide every send. Pure.
 */
export function instagramResearchHold(input: { profileRead: boolean; placeNamed: boolean; where: string | null | undefined }): string | null {
  if (!input.profileRead) return "its Instagram profile could not be read, so the account is not verified; kept for research, not contacted";
  const place = (input.where ?? "").split(",")[0]?.trim();
  if (place && !input.placeNamed) return `its location is not verified: neither its profile nor the post names ${place} (a hashtag or search alone does not place it); kept for research, not contacted`;
  return null;
}

/** A commenter's handle is all a post's comments give: its profile and place are unchecked. */
export function instagramCommenterHold(postUrl: string): string {
  return `found as a commenter on ${postUrl}; its own profile and location were not checked, so it is kept for research and not contacted`;
}
