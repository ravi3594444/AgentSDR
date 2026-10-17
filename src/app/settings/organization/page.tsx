import { ChannelRulesForm } from "@/components/settings/ChannelRulesForm";
import { ApifySettings } from "@/components/settings/organization/ApifySettings";
import { OrgFeatures } from "@/components/settings/organization/OrgFeatures";
import { OrgGeneral } from "@/components/settings/organization/OrgGeneral";
import { TavilySettings } from "@/components/settings/organization/TavilySettings";
import { TregSettings } from "@/components/settings/organization/TregSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { channelRulesForSettings } from "@/lib/channels/rules.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Organization" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { values } = await runInOrganization(ctx.organizationId, () => channelRulesForSettings("general"));
  return (
    <SettingsPage title="Organization" description="Your organization's name, URL and your role in it." width="narrow">
      <div className="flex flex-col gap-8">
        <OrgGeneral />
        <section className="flex flex-col gap-3" aria-labelledby="org-defaults">
          <div>
            <h3 id="org-defaults" className="text-label-md text-text-strong-950">Defaults</h3>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">Used across every channel.</p>
          </div>
          <ChannelRulesForm channel="general" initialValues={values} canEdit={can(ctx, { integrations: ["manage"] })} />
        </section>
        <OrgFeatures />
        <TavilySettings />
        <ApifySettings />
        <TregSettings />
      </div>
    </SettingsPage>
  );
}
