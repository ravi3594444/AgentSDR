import { redirect } from "next/navigation";
import { SETTINGS_HOME } from "@/components/settings/settingsNav";
import { withQuery } from "@/lib/nav/legacyRoutes";

export const dynamic = "force-dynamic";

// The old General page was split up: name, URL and the business profile are on
// Your business (here, with the day and phone country), research
// defaults, TinyFish and sources on Lead research, and optional features and
// providers on Providers & features. Old links keep their query.
export default async function OldOrganizationSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery(SETTINGS_HOME, await searchParams));
}
