import { RulesSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "Instagram sending rules" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <RulesSettingsPage
      channel="instagram"
      title="Instagram sending rules"
      description="Limit initial DMs per account, the gap between sends, and sending hours. These are your app's limits; Instagram can apply stricter account or recipient restrictions. Each approved recipient receives one initial DM. Replies follow the run's reply mode."
    />
  );
}
