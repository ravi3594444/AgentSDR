import Link from "next/link";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { MUTED_STRONG, STATUS } from "@/components/analytics/theme";
import { Callout, Meter } from "@/components/settings/SettingsKit";
import { describeLeadDay } from "@/lib/channels/dailyLeadLimit";

/**
 * Today's use of the daily lead limit, read on the server from the engines'
 * own claim rows (newLeadsToday), and when it resets. The day is the
 * workspace's (Your business → Time zone, New day starts at): this screen has
 * no time-zone control of its own.
 */
export function DailyLeadLimitToday({ day }: { day: { used: number; limit: number; resetsAt: Date; timeZone: string; dayStartsAt: string } }) {
  const text = describeLeadDay(day);
  return (
    <div className="flex flex-col gap-3">
      <Frame>
        <FramePanel className="flex flex-col gap-2 px-4 py-3.5">
          <p className="text-label-sm text-text-strong-950">Today</p>
          <Meter value={day.used} max={day.limit} color={text.reached ? STATUS.warning : MUTED_STRONG} label="New leads contacted today" />
          <p className="text-paragraph-sm text-text-sub-600">{text.used}.</p>
          <p className="text-paragraph-xs text-text-sub-600">
            {text.resets}{" "}
            <Link href="/settings/business" className="text-text-strong-950 underline decoration-stroke-sub-300 underline-offset-2 hover:decoration-text-strong-950">
              Change your day
            </Link>
          </p>
        </FramePanel>
      </Frame>
      {text.reached && (
        <Callout tone="warning" title="Daily lead limit reached">
          First messages to new people wait until the reset. Follow-ups, replies, and first messages to people already contacted on another channel still go out.
        </Callout>
      )}
    </div>
  );
}
