import AppearanceSettings from "@/components/settings/AppearanceSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "Appearance" };

export default function AppearancePage() {
  return (
    <SettingsPage title="Appearance" description="Plain white, pure black, your device's setting, or an illustrated background." width="narrow">
      <AppearanceSettings />
    </SettingsPage>
  );
}
