"use client";

import { RiComputerLine } from "@remixicon/react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ThemeSwitch } from "@/components/theme/ThemeSwitch";
import { BRAND } from "@/lib/brand";

export default function AppearanceSettings() {
  const { preference, resolved } = useTheme();
  return (
    <Frame>
      <FrameHeader title="Make this space yours" description={`Choose how ${BRAND.shortName} looks. Changes appear instantly.`} />
      <FramePanel>
        <ThemeSwitch variant="cards" />
        <div className="mt-5 flex items-start gap-2 border-t border-stroke-soft-200 pt-4 text-paragraph-xs leading-relaxed text-text-sub-600" role="status">
          <RiComputerLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {preference === "system" ? `Following your device. Currently showing ${resolved === "dark" ? "pure black" : "light"} mode.` : `${resolved === "dark" ? "Pure black" : "Light"} mode is selected. Choose System to match your device automatically.`}
        </div>
      </FramePanel>
      <FrameFooter>Saved on this browser. Your other devices keep their own appearance.</FrameFooter>
    </Frame>
  );
}
