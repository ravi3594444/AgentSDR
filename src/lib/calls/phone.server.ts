import "server-only";

import { channelRules } from "@/lib/channels/rules.server";

/**
 * The country assumed for phone numbers typed without a + in the
 * organization in scope: its own setting (Settings → Sending defaults → Default phone
 * country), else the instance's DEFAULT_PHONE_COUNTRY, else none.
 */
export async function organizationPhoneCountry(): Promise<string | undefined> {
  const { defaultPhoneCountry } = await channelRules("general");
  return defaultPhoneCountry || process.env.DEFAULT_PHONE_COUNTRY || process.env.NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY || undefined;
}
