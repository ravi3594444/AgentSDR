import type { Metadata } from "next";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { brandTitle } from "@/lib/brand";

export const metadata: Metadata = {
  title: {
    default: brandTitle("Settings"),
    template: brandTitle("%s", "Settings"),
  },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
