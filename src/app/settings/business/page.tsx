import { BusinessProfileForm } from "@/components/settings/business/BusinessProfileForm";
import { ChannelRulesForm } from "@/components/settings/ChannelRulesForm";
import { OrgGeneral } from "@/components/settings/organization/OrgGeneral";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { businessProfileSettings } from "@/lib/assistant/profileSettings.server";
import { GENERAL_RULE_PAGES } from "@/lib/channels/rules";
import { channelRulesForSettings } from "@/lib/channels/rules.server";
import { featureState } from "@/lib/features/flags.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Your business" };
export const dynamic = "force-dynamic";

/**
 * The business profile the assistant and reply drafts write from; the
 * organization's day (when daily limits reset) and the country assumed for
 * phone numbers; then the organization's own name and URL.
 */
export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { settings, features, general } = await runInOrganization(ctx.organizationId, async () => ({
    settings: await businessProfileSettings(ctx),
    features: await featureState(),
    general: await channelRulesForSettings("general"),
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
        <ChannelRulesForm
          channel="general"
          keys={GENERAL_RULE_PAGES.business}
          initialValues={general.values}
          canEdit={can(ctx, { integrations: ["manage"] })}
          title="Your day and phone numbers"
          description="When your day starts, so daily limits reset on your calendar, and the country assumed for numbers written without a country code."
        />
        <OrgGeneral />
      </div>
    </SettingsPage>
  );
}
