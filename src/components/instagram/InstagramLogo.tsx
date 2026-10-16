import { RiInstagramFill } from "@remixicon/react";
import { CONVERSATION_CHANNEL_META } from "@/components/analytics/theme";
import { cn } from "@/utils/cn";

/** Instagram's mark in the channel's identity colour — where a conversation is on Instagram. */
export function InstagramLogo({ className }: { className?: string }) {
  return (
    <span style={{ color: CONVERSATION_CHANNEL_META.instagram.color }} className="inline-flex shrink-0">
      <RiInstagramFill className={cn("size-4 shrink-0", className)} aria-hidden="true" />
    </span>
  );
}

/** The channel's name beside its mark, like the inbox's channel tags. */
export function InstagramTag({ label = "Instagram" }: { label?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-paragraph-xs text-text-sub-600">
      <InstagramLogo className="size-3.5" />
      {label}
    </span>
  );
}
