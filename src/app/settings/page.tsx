import { redirect } from "next/navigation";
import { SETTINGS_HOME } from "@/components/settings/settingsNav";
import { withQuery } from "@/lib/nav/legacyRoutes";

export const dynamic = "force-dynamic";

/** /settings opens its first section, keeping the query (a hosted-auth return may carry one). */
export default async function SettingsIndexPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery(SETTINGS_HOME, await searchParams));
}
