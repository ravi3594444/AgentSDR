import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "Email connection" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <ConnectionSettingsPage
      platforms={[
        { platform: "google" },
        {
          platform: "unipile",
          note: "Sends from inboxes linked in your Unipile workspace (Gmail, Outlook, iCloud, IMAP); no domain needed. Then use Sync from Unipile in Email → Accounts. The same connection also powers LinkedIn and WhatsApp.",
        },
      ]}
      title="Email connection"
      description="Email sends either through a Google Workspace service account (addresses on your own domain) or through inboxes linked in Unipile. Connect either one; each mailbox in Email → Accounts uses its own."
    />
  );
}
