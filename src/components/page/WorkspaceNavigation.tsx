import Link from "next/link";
import { cn } from "@/utils/cn";

/** The tabs inside a destination: Outreach's chat, requests and reports, or Leads' list and board. */
export function WorkspaceNavigation({ area, active }: { area: "outreach" | "leads"; active: string }) {
  const links = area === "outreach"
    ? [{ href: "/assistant", label: "Chat" }, { href: "/assistant/requests", label: "Requests" }, { href: "/assistant/reports", label: "Reports" }]
    : [{ href: "/leads", label: "List" }, { href: "/leads?view=board", label: "Board" }];
  return <nav aria-label={area === "outreach" ? "Outreach views" : "Lead views"} className="flex flex-wrap gap-5 border-b border-stroke-soft-200">
    {links.map((link) => <Link key={link.href} href={link.href} aria-current={active === link.href ? "page" : undefined}
      className={cn("-mb-px border-b-2 px-0.5 py-3 text-label-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-base", active === link.href ? "border-text-strong-950 text-text-strong-950" : "border-transparent text-text-sub-600 hover:text-text-strong-950")}>
      {link.label}
    </Link>)}
  </nav>;
}

type Stat = { label: string; value: string | number; detail?: string; selected?: boolean; onSelect?: () => void };

/** Compact totals leave the page's width and height for the actual work. */
export function WorkspaceStats({ items, className }: { items: Stat[]; className?: string }) {
  return <div role="group" aria-label="Summary" className={cn("grid grid-cols-2 gap-x-6 gap-y-5 py-5 sm:flex sm:flex-wrap sm:gap-x-10", className)}>
    {items.map((item) => {
      const content = <><span className="block text-paragraph-xs text-text-sub-600">{item.label}</span><span className="mt-1 block text-[26px] font-semibold leading-tight tracking-tight text-text-strong-950 tabular-nums">{item.value}</span>{item.detail && <span className="mt-1 block text-paragraph-xs text-text-soft-400">{item.detail}</span>}</>;
      return item.onSelect
        ? <button key={item.label} type="button" aria-pressed={item.selected} onClick={item.onSelect} className={cn("rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-base", item.selected && "underline decoration-stroke-sub-300 underline-offset-4")}>{content}</button>
        : <div key={item.label}>{content}</div>;
    })}
  </div>;
}
