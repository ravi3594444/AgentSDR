import { ChannelRulesForm } from "@/components/settings/ChannelRulesForm";
import { DailyLeadLimitToday } from "@/components/settings/DailyLeadLimitToday";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { newLeadsToday } from "@/lib/channels/dailyLeadLimit.server";
import { GENERAL_RULE_PAGES } from "@/lib/channels/rules";
import { channelRulesForSettings } from "@/lib/channels/rules.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Daily lead limit" };
export const dynamic = "force-dynamic";

/**
 * The one sending setting: how many people may be contacted for the first
 * time a day, across every channel. Sending itself is always on, and each
 * sender's pacing is automatic; the day it counts in is set on Your business.
 */
export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { values, today } = await runInOrganization(ctx.organizationId, async () => ({
    values: (await channelRulesForSettings("general")).values,
    today: await newLeadsToday(),
  }));
  return (
    <SettingsPage
      title="Daily lead limit"
      description="How many new people AgentSDR may contact in a day, across email, LinkedIn, WhatsApp and Instagram together. Sending runs at any time, every day; each mailbox, LinkedIn account and number is paced automatically to keep it safe."
      width="narrow"
    >
      <div className="flex flex-col gap-6">
        <DailyLeadLimitToday day={today} />
        <ChannelRulesForm channel="general" keys={GENERAL_RULE_PAGES.sending} initialValues={values} canEdit={can(ctx, { integrations: ["manage"] })} />
      </div>
    </SettingsPage>
  );
}
