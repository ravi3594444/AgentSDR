import "server-only";

import { can, requirePermission, type OrgContext } from "@/lib/auth/context";
import { profileChanges, profilePatchProblems } from "./profile";
import { businessProfileRecord, updateBusinessProfile } from "./profile.server";
import type { BusinessProfile } from "./schema";

/**
 * Settings → Your business (GET/PATCH /api/settings/business-profile): the
 * same profile row the chat's save_business_info writes, edited as a form.
 * Every member can read it; changing it takes the permission that changes
 * the organization's name (owners and admins). Run inside the caller's
 * organization scope.
 */

/** Who may change the profile from Settings: the same people who may rename the organization. */
export const BUSINESS_PROFILE_EDIT: Parameters<typeof can>[1] = { organization: ["update"] };

/** A profile edit that cannot be saved as sent (an unknown field, a value of the wrong shape); a 400. */
export class BusinessProfileInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "BusinessProfileInputError";
  }
}

export type BusinessProfileSettings = {
  profile: BusinessProfile;
  knowledgeDocumentId: string | null;
  updatedAt: Date | null;
  canEdit: boolean;
};

export async function businessProfileSettings(ctx: Pick<OrgContext, "roles">): Promise<BusinessProfileSettings> {
  return { ...(await businessProfileRecord()), canEdit: can(ctx, BUSINESS_PROFILE_EDIT) };
}

/**
 * Apply `patch` (only the fields that changed; an empty string clears one)
 * and rewrite the Knowledge copy with it. A patch that changes nothing
 * writes nothing, so the copy gains no empty version.
 */
export async function saveBusinessProfileSettings(
  ctx: Pick<OrgContext, "roles" | "userId">,
  patch: unknown,
): Promise<BusinessProfileSettings & { profileChanges: string[] }> {
  requirePermission(ctx, BUSINESS_PROFILE_EDIT);
  const problems = profilePatchProblems(patch);
  if (problems.length) throw new BusinessProfileInputError(problems);
  const fields = patch as Record<string, unknown>;
  const before = await businessProfileRecord();
  const changes = profileChanges(before.profile, fields);
  if (changes.length) {
    const saved = await updateBusinessProfile(fields, ctx.userId);
    // profilePatchProblems accepts only what mergeProfile stores as sent.
    if (saved.problems.length) throw new BusinessProfileInputError(saved.problems);
  }
  return { ...(changes.length ? await businessProfileRecord() : before), canEdit: true, profileChanges: changes };
}
