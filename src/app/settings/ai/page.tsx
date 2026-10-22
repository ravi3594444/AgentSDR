import AiSettingsClient from "@/components/ai/AiSettingsClient";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ServiceModeNotice } from "@/components/settings/ServiceModeNotice";

export const metadata = { title: "AI provider" };
export const dynamic = "force-dynamic";

export default function AiSettingsPage() {
  return (
    <SettingsPage title="AI provider" description="The provider, key and models every AI feature uses: OpenRouter or AI/ML API.">
      <div className="flex flex-col gap-6">
        <ServiceModeNotice service="ai" />
        <AiSettingsClient />
      </div>
    </SettingsPage>
  );
}
