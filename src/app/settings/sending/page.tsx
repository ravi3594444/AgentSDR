import { ChannelRulesForm } from "@/components/settings/ChannelRulesForm";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { GENERAL_RULE_PAGES } from "@/lib/channels/rules";
import { channelRulesForSettings } from "@/lib/channels/rules.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Sending defaults" };
export const dynamic = "force-dynamic";

/** The "general" Sending rules that apply across channels; a request's research defaults are on Lead research. */
export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { values } = await runInOrganization(ctx.organizationId, () => channelRulesForSettings("general"));
  return (
    <SettingsPage
      title="Sending defaults"
      description="Your organization's day, phone numbers typed without a country code, and how much the assistant may start on its own in Autonomous mode. Each channel's own sending rules apply on top."
      width="narrow"
    >
      <ChannelRulesForm channel="general" keys={GENERAL_RULE_PAGES.sending} initialValues={values} canEdit={can(ctx, { integrations: ["manage"] })} />
    </SettingsPage>
  );
}
