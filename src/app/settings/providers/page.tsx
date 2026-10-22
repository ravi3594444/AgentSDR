import { ProviderChoices } from "@/components/settings/ProviderChoices";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "Use your own providers" };
export const dynamic = "force-dynamic";

/**
 * Advanced → Use your own providers: per service, the Included service (no
 * account or key needed) or My own provider (this workspace's own account,
 * set up on the technical pages it links to).
 */
export default function Page() {
  return (
    <SettingsPage
      title="Use your own providers"
      description="AI, research and account connections are included with your workspace. Choose My own provider for any of them only if you want to use an account of your own; its technical settings are on the pages linked below."
      width="narrow"
    >
      <ProviderChoices />
    </SettingsPage>
  );
}
