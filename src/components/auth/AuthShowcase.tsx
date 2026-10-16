import Image from "next/image";
import { RiCheckLine, RiLinkedinBoxLine, RiMailLine, RiWhatsappLine } from "@remixicon/react";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

/** Decorative product introduction; the example below is illustrative. */
export function AuthShowcase({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative flex h-full min-h-[680px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a0a] px-10 py-10 text-white xl:px-14", className)}>
      <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.15em] text-neutral-400">
        <span>{BRAND.shortName}</span><span>A little more connection</span>
      </div>
      <div className="relative my-8 min-h-48 flex-1">
        <Image src="/landing/sculpture-light.webp" alt="" fill sizes="50vw" className="object-contain grayscale invert mix-blend-screen" />
      </div>
      <h2 className="text-[clamp(36px,3.8vw,58px)] font-medium leading-[1.05] tracking-[-0.045em]">Less busywork.<br /><span className="font-instrument-serif font-normal italic">More connection.</span></h2>
      <p className="mt-5 max-w-md text-[13px] leading-7 text-neutral-400">Find your people, shape the outreach, and make room for the conversations that matter.</p>
      <div className="mt-8 rounded-xl border border-white/15 bg-black p-5">
        <div className="flex items-center justify-between gap-3 text-[10px] text-neutral-500"><span>YOUR NEXT MOVE</span><span>Illustrative preview</span></div>
        <p className="mt-4 text-sm text-white">Your introduction is ready to review.</p>
        <p className="mt-2 text-xs leading-6 text-neutral-400">A thoughtful first message, shaped around your offer.</p>
        <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-4 text-[11px] text-neutral-300"><RiCheckLine className="size-4" />You decide when to start.</div>
      </div>
      <div className="mt-8 flex items-center gap-7 text-[11px] text-neutral-400">
        <span className="flex items-center gap-2"><RiMailLine className="size-4" />Email</span>
        <span className="flex items-center gap-2"><RiLinkedinBoxLine className="size-4" />LinkedIn</span>
        <span className="flex items-center gap-2"><RiWhatsappLine className="size-4" />WhatsApp</span>
      </div>
    </div>
  );
}
