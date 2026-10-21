"use client";

import { RiComputerLine } from "@remixicon/react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ThemeSwitch } from "@/components/theme/ThemeSwitch";
import { THEMES } from "@/components/theme/themes";
import { BRAND } from "@/lib/brand";

export default function AppearanceSettings() {
  const { preference, resolved } = useTheme();
  const theme = THEMES[preference];
  return (
    <Frame>
      <FrameHeader title="Make this space yours" description={`Choose how ${BRAND.shortName} looks. Changes appear instantly.`} />
      <FramePanel>
        <ThemeSwitch variant="cards" />
        <div className="mt-5 flex items-start gap-2 border-t border-stroke-soft-200 pt-4 text-paragraph-xs leading-relaxed text-text-sub-600" role="status">
          <RiComputerLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {preference === "system" ? `Following your device. Currently showing ${resolved === "dark" ? "pure black" : "light"} mode.` : theme.thumbnail ? `${theme.label} is selected. The artwork stays behind your work, with solid surfaces for messages and tables.` : `${theme.label} mode is selected. Choose an illustrated background above, or System to match your device.`}
        </div>
      </FramePanel>
      <FrameFooter>White is the default. Your choice is saved on this browser; other devices keep their own appearance.</FrameFooter>
    </Frame>
  );
}
