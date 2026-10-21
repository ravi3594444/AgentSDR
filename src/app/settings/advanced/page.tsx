import { ApifySettings } from "@/components/settings/organization/ApifySettings";
import { BrightdataSettings } from "@/components/settings/organization/BrightdataSettings";
import { OrgFeatures } from "@/components/settings/organization/OrgFeatures";
import { TavilySettings } from "@/components/settings/organization/TavilySettings";
import { TregSettings } from "@/components/settings/organization/TregSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "Providers & features" };
export const dynamic = "force-dynamic";

/** Optional features, and the paid providers some of them use; each card loads its own settings and permissions. */
export default function Page() {
  return (
    <SettingsPage
      title="Providers & features"
      description="Features that stay off until you turn them on, and the paid providers some of them use: Tavily, Apify, Treg and Bright Data."
      width="narrow"
    >
      <div className="flex flex-col gap-8">
        <OrgFeatures />
        <TavilySettings />
        <ApifySettings />
        <TregSettings />
        <BrightdataSettings />
      </div>
    </SettingsPage>
  );
}
