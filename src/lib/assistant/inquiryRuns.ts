import type { FeatureState } from "@/lib/features/catalog";

/** Pure rules for inquiry runs (inquiryRuns.server.ts). */

export type InquiryAccount = { unipileAccountId: string; username: string | null; status: string; inquiryIntake: boolean };

/**
 * Why answering new inquiries cannot be set up, or null: both optional
 * features must be on, and at least one connected Instagram account must
 * treat new messages from unknown people as inquiries.
 */
export function inquiryRunProblem(input: { features: Pick<FeatureState, "instagram" | "inquiry_intake">; accounts: readonly InquiryAccount[] }): string | null {
  if (!input.features.instagram) return "Instagram messages are off for this organization. An owner or admin can turn them on in Settings → Organization → Optional features.";
  if (!input.features.inquiry_intake) return "Inquiry intake is off for this organization. An owner or admin can turn it on in Settings → Organization → Optional features.";
  const connected = input.accounts.filter((account) => account.status === "connected");
  if (!connected.length) return "No Instagram account is connected. Link one in Settings → Instagram.";
  if (!connected.some((account) => account.inquiryIntake)) {
    return "No connected Instagram account treats new messages as inquiries yet. Turn that on for an account in Settings → Instagram.";
  }
  return null;
}
