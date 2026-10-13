"use client";

import { RiMoonLine, RiSunLine } from "@remixicon/react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ThemeSwitch } from "@/components/theme/ThemeSwitch";
import { FieldRow } from "./SettingsKit";
import { BRAND } from "@/lib/brand";

const SHOWING = {
  light: { label: "Light", icon: RiSunLine },
  dark: { label: "Dark", icon: RiMoonLine },
} as const;

/** The Appearance section: the Light / Dark / System switch and what it is doing right now. */
export default function AppearanceSettings() {
  const { preference, resolved } = useTheme();
  const Showing = SHOWING[resolved].icon;

  return (
    <Frame>
      <FrameHeader title="Theme" description={`How ${BRAND.shortName} looks on this browser.`} />
      <FramePanel>
        <FieldRow
          label="Colour theme"
          description="System follows your computer's light or dark setting and switches when it does."
        >
          <ThemeSwitch className="w-full" />
          {preference === "system" && (
            <p className="mt-2 flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
              <Showing className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
              Showing {SHOWING[resolved].label.toLowerCase()}, from your system setting
            </p>
          )}
        </FieldRow>
      </FramePanel>
      <FrameFooter>
        Remembered on this browser only. Other browsers and devices keep their own choice, and nothing is saved to your workspace.
      </FrameFooter>
    </Frame>
  );
}
