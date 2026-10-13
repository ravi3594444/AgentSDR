import Image from "next/image";
import {
  RiArrowRightSLine,
  RiLinkedinBoxFill,
  RiMailFill,
  RiQuillPenLine,
  RiSparkling2Line,
  RiTimeLine,
  RiWhatsappFill,
} from "@remixicon/react";
import { AppIcon } from "@/components/brand/Logo";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

/**
 * The panel beside the auth forms: a photograph, and over it a slice of
 * the product doing its job — the morning's replies from every channel,
 * each already sorted. The table bleeds off the right edge on purpose: it
 * is a window onto the app, not a picture of all of it.
 *
 * Every person and company here is fictional (the same names the demo
 * seed uses). Decorative: hidden from assistive tech.
 *
 * Photo: Marek Piwnicki, https://unsplash.com/photos/w4sxddUJ5-0 — free
 * under the Unsplash License (https://unsplash.com/license).
 */

type Channel = "email" | "linkedin" | "whatsapp";
type Category = "Interested" | "Meeting booked" | "Out of office" | "Not now" | "Referral";

const REPLIES: { name: string; role: string; channel: Channel; reply: string; category: Category; tint: string }[] = [
  { name: "Sana Brennan", role: "Head of Ops · Pinecrest Health", channel: "linkedin", reply: "Yes, this is timely. Could we talk Thursday?", category: "Interested", tint: "bg-sky-100 text-sky-800" },
  { name: "Diego Underhill", role: "VP Sales · Harborview Logistics", channel: "email", reply: "Let's move forward. Who handles the contract?", category: "Meeting booked", tint: "bg-amber-100 text-amber-800" },
  { name: "Amara Lindqvist", role: "RevOps Lead · Tallgrass Energy", channel: "whatsapp", reply: "Send over the deck and pricing, please.", category: "Interested", tint: "bg-emerald-100 text-emerald-800" },
  { name: "Theo Marlowe", role: "Director of CS · Saltmarsh Foods", channel: "email", reply: "Out until Monday, back on the 14th.", category: "Out of office", tint: "bg-orange-100 text-orange-800" },
  { name: "Hugo Okafor", role: "CRO · Zephyr Cloudworks", channel: "email", reply: "Booked Tuesday 10:00 on your calendar.", category: "Meeting booked", tint: "bg-violet-100 text-violet-800" },
  { name: "Nia Zielinski", role: "SDR Manager · Redwood Robotics", channel: "linkedin", reply: "Not this quarter. Ping me again in January.", category: "Not now", tint: "bg-rose-100 text-rose-800" },
  { name: "Mei Rasmussen", role: "Marketing Manager · Brightloop", channel: "whatsapp", reply: "Forwarding this to our head of growth.", category: "Referral", tint: "bg-indigo-100 text-indigo-800" },
  { name: "Lucas Yilmaz", role: "Founder · Verdant Learning", channel: "linkedin", reply: "Interesting. What does onboarding look like?", category: "Interested", tint: "bg-teal-100 text-teal-800" },
];

const CHANNEL = {
  email: { Icon: RiMailFill, label: "Email", className: "text-[#f26b3a]" },
  linkedin: { Icon: RiLinkedinBoxFill, label: "LinkedIn", className: "text-[#0a66c2]" },
  whatsapp: { Icon: RiWhatsappFill, label: "WhatsApp", className: "text-[#1fae55]" },
} satisfies Record<Channel, { Icon: typeof RiMailFill; label: string; className: string }>;

const CATEGORY: Record<Category, string> = {
  Interested: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  "Meeting booked": "bg-[#335cff]/[0.08] text-[#2547d0] ring-[#335cff]/20",
  "Out of office": "bg-amber-50 text-amber-700 ring-amber-600/15",
  "Not now": "bg-zinc-100 text-zinc-600 ring-zinc-500/15",
  Referral: "bg-violet-50 text-violet-700 ring-violet-600/15",
};

const CHIPS = [
  { Icon: RiSparkling2Line, label: "Classify every reply" },
  { Icon: RiQuillPenLine, label: "Draft the next message" },
  { Icon: RiTimeLine, label: "Follow up on time" },
];

/** Lead, channel, category, reply: the reply runs off the right edge. */
const COLUMNS = "grid grid-cols-[220px_112px_150px_1fr]";

const initials = (name: string) => name.split(" ").map((p) => p[0]).join("");

/** Glass on the photograph: the status line above the table and the chips below it. */
const glass = "border border-white/15 bg-black/25 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur-md";

export function AuthShowcase({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative h-full w-full overflow-hidden rounded-[28px] bg-[#05070f]", className)}>
      <Image src="/auth/blue-light.webp" alt="" fill sizes="50vw" className="object-cover object-[50%_35%]" />
      {/* Settle the photo so the white table reads cleanly against it. */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/10 to-black/60" />

      {/* Status line, table and chips: one column, centred, bleeding off the right edge. */}
      <div className="absolute inset-y-0 left-[8%] right-0 flex flex-col justify-center gap-6 py-10">
        <div className={cn(glass, "flex items-center gap-2.5 self-start rounded-full py-1.5 pl-1.5 pr-3 text-[13px]")}>
          <AppIcon small className="size-6" />
          <span className="font-medium">{BRAND.shortName} sorted 24 replies overnight</span>
          <RiArrowRightSLine className="size-4 text-white/60" />
        </div>

        <div className="w-[max(780px,100%)] shrink-0 overflow-hidden rounded-xl bg-white text-zinc-900 shadow-[0_30px_80px_-20px_rgb(2_6_23/0.7),0_0_0_1px_rgb(255_255_255/0.4)]">
          <div className="flex items-center gap-3 border-b border-zinc-200/80 px-5 py-3.5">
            <span className="text-[15px] font-semibold tracking-[-0.01em]">Replies</span>
            <span className="text-[13px] text-zinc-500">24 new today</span>
            <div className="ml-6 flex gap-1 text-[12px] font-medium">
              <span className="rounded-md bg-zinc-900 px-2 py-1 text-white">All</span>
              <span className="rounded-md px-2 py-1 text-zinc-500">Interested 9</span>
              <span className="rounded-md px-2 py-1 text-zinc-500">Meetings 3</span>
            </div>
          </div>
          <div className={cn(COLUMNS, "border-b border-zinc-200/80 bg-zinc-50 px-5 py-2 text-[12px] font-medium text-zinc-500")}>
            <span>Lead</span>
            <span>Channel</span>
            <span>Category</span>
            <span>Reply</span>
          </div>
          <div className="relative">
            {REPLIES.map((r) => {
              const ch = CHANNEL[r.channel];
              return (
                <div key={r.name} className={cn(COLUMNS, "items-center border-b border-zinc-100 px-5 py-2.5 text-[13px] last:border-b-0")}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", r.tint)}>{initials(r.name)}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium leading-tight">{r.name}</span>
                      <span className="block truncate text-[11.5px] leading-tight text-zinc-500">{r.role}</span>
                    </span>
                  </div>
                  <span className="flex items-center gap-1.5 text-zinc-600">
                    <ch.Icon className={cn("size-4", ch.className)} />
                    {ch.label}
                  </span>
                  <span>
                    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset", CATEGORY[r.category])}>{r.category}</span>
                  </span>
                  <span className="truncate pr-5 text-zinc-700">{r.reply}</span>
                </div>
              );
            })}
            {/* The list carries on below the fold. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-white/0 to-white" />
          </div>
          <div className="flex items-center gap-3 border-t border-zinc-200/80 bg-zinc-50 px-5 py-2.5 text-[12px] text-zinc-500">
            <span>
              <span className="font-medium text-zinc-800">24</span> classified
            </span>
            <span className="h-3 w-px bg-zinc-300" />
            <span>
              <span className="font-medium text-zinc-800">9</span> drafts ready
            </span>
            <span className="h-3 w-px bg-zinc-300" />
            <span>
              <span className="font-medium text-zinc-800">3</span> meetings booked
            </span>
          </div>
        </div>

        <div className="flex gap-2.5 whitespace-nowrap">
          {CHIPS.map(({ Icon, label }) => (
            <span key={label} className={cn(glass, "flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-[15px] font-medium")}>
              <Icon className="size-[18px] text-white/80" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
