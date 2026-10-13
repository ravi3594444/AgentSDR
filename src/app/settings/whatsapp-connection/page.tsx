import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";
import { RecorderExtensionCard } from "@/components/settings/RecorderExtensionCard";
import { BRAND } from "@/lib/brand";
import { isReleased } from "@/lib/release";

export const metadata = { title: "WhatsApp integrations" };
export const dynamic = "force-dynamic";

export default function Page() {
  // Without calling (src/lib/release.ts) there are no recordings: no R2 bucket and no recorder extension to set up.
  if (!isReleased("calling")) {
    return (
      <ConnectionSettingsPage
        platforms={[{ platform: "unipile", note: "The same Unipile connection also powers LinkedIn; changing it here changes it there too." }]}
        title="WhatsApp integrations"
        description="Unipile connects your WhatsApp numbers for messaging: campaigns, replies and the chats in WhatsApp → Messages. Link a number in the Unipile dashboard, then sync it under Numbers."
      />
    );
  }
  return (
    <ConnectionSettingsPage
      platforms={[
        { platform: "unipile", note: "The same Unipile connection also powers LinkedIn; changing it here changes it there too." },
        { platform: "r2" },
      ]}
      title="WhatsApp integrations"
      description={`Unipile connects your WhatsApp numbers for messaging and calling. Calls placed from ${BRAND.shortName} are recorded by the Call Recorder extension and stored in your Cloudflare R2 bucket, along with contact photos. Transcription uses the model chosen in AI provider.`}
    >
      <RecorderExtensionCard />
    </ConnectionSettingsPage>
  );
}
