import { cn } from "@/utils/cn";

/**
 * The assistant's mascot: a small owl, the one that looks for your
 * customers. It moves only while work is running ("searching": its eyes
 * scan; "thinking": it looks up), hops once when research finishes
 * ("done") and looks down when it stopped on a failure ("stuck"); at rest
 * and under reduced motion it holds still (globals.css, .mascot). Drawn in
 * the theme's own colours, so it follows light, dark and the workspace
 * appearances; the beak and feet carry the one accent.
 */

export type MascotMood = "idle" | "searching" | "thinking" | "done" | "stuck";

export function Mascot({ mood = "idle", className, title }: { mood?: MascotMood; className?: string; title?: string }) {
  const happy = mood === "done";
  return (
    <svg viewBox="0 0 48 48" className={cn("mascot shrink-0 overflow-visible text-text-strong-950", className)} data-mood={mood} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <g className="mascot-body">
        <path d="M11.5 13.5 13 5l6.5 5.5M36.5 13.5 35 5l-6.5 5.5" fill="currentColor" />
        <path d="M24 7.5c-9.2 0-15 6.4-15 15.3V32c0 6.9 6.6 11 15 11s15-4.1 15-11v-9.2c0-8.9-5.8-15.3-15-15.3Z" fill="currentColor" />
        <ellipse cx="24" cy="34.5" rx="9.5" ry="7" className="fill-bg-white-0" opacity="0.16" />
        <path d="M19.5 33.5l2 1.6 2-1.6 2 1.6 2-1.6M21.5 37.5l2 1.6 2-1.6" fill="none" className="stroke-bg-white-0" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" />
        <circle cx="17" cy="21.5" r="7" className="fill-bg-white-0" />
        <circle cx="31" cy="21.5" r="7" className="fill-bg-white-0" />
        {happy ? (
          <path d="M13.6 23c1.9-3.2 4.9-3.2 6.8 0M27.6 23c1.9-3.2 4.9-3.2 6.8 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        ) : (
          <g className="mascot-pupils">
            <circle cx="17" cy="22" r="3.3" fill="currentColor" />
            <circle cx="31" cy="22" r="3.3" fill="currentColor" />
            <circle cx="18.2" cy="20.8" r="1.05" className="fill-bg-white-0" />
            <circle cx="32.2" cy="20.8" r="1.05" className="fill-bg-white-0" />
          </g>
        )}
        <g className="mascot-lids">
          <ellipse cx="17" cy="21.5" rx="7.4" ry="7.4" fill="currentColor" />
          <ellipse cx="31" cy="21.5" rx="7.4" ry="7.4" fill="currentColor" />
        </g>
        <path d="M24 26.2l-2.5 2.2 2.5 3.4 2.5-3.4Z" className="fill-warning-base" />
        <ellipse cx="19.5" cy="43.2" rx="3" ry="1.5" className="fill-warning-base" />
        <ellipse cx="28.5" cy="43.2" rx="3" ry="1.5" className="fill-warning-base" />
      </g>
    </svg>
  );
}
