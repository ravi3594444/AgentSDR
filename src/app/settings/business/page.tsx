import { BusinessProfileForm } from "@/components/settings/business/BusinessProfileForm";
import { OrgGeneral } from "@/components/settings/organization/OrgGeneral";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { businessProfileSettings } from "@/lib/assistant/profileSettings.server";
import { featureState } from "@/lib/features/flags.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Your business" };
export const dynamic = "force-dynamic";

/** The business profile the assistant and reply drafts write from, then the organization's own name and URL. */
export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { settings, features } = await runInOrganization(ctx.organizationId, async () => ({
    settings: await businessProfileSettings(ctx),
    features: await featureState(),
  }));
  return (
    <SettingsPage
      title="Your business"
      description="What you sell, who to, and how messages are signed. The assistant writes outreach from this, and reply drafts use it too."
      width="narrow"
    >
      <div className="flex flex-col gap-8">
        <BusinessProfileForm
          initialProfile={settings.profile}
          canEdit={settings.canEdit}
          organizationName={ctx.organizationName}
          instagram={features.instagram}
        />
        <OrgGeneral />
      </div>
    </SettingsPage>
  );
}
