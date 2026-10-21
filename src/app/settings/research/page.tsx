import { ChannelRulesForm } from "@/components/settings/ChannelRulesForm";
import { ResearchSourcesSettings } from "@/components/settings/organization/ResearchSourcesSettings";
import { TinyfishSettings } from "@/components/settings/organization/TinyfishSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { GENERAL_RULE_PAGES } from "@/lib/channels/rules";
import { channelRulesForSettings } from "@/lib/channels/rules.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Lead research" };
export const dynamic = "force-dynamic";

/** A request's research defaults (the "general" objective rules), TinyFish web access and the free research sources. */
export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { values } = await runInOrganization(ctx.organizationId, () => channelRulesForSettings("general"));
  return (
    <SettingsPage
      title="Lead research"
      description="How many leads one request looks for, how long it may keep searching and what it may spend, and the web access and sources it searches with."
      width="narrow"
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-3" aria-labelledby="research-defaults">
          <div>
            <h3 id="research-defaults" className="text-label-md text-text-strong-950">Each request</h3>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">Used when a request names no number, time or budget of its own.</p>
          </div>
          <ChannelRulesForm channel="general" keys={GENERAL_RULE_PAGES.research} initialValues={values} canEdit={can(ctx, { integrations: ["manage"] })} />
        </section>
        <TinyfishSettings />
        <ResearchSourcesSettings />
      </div>
    </SettingsPage>
  );
}
