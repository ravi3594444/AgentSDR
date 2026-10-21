const TONE_CLS = {
  slate: "bg-bg-weak-50 text-text-sub-600",
  indigo: "bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  emerald: "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  amber: "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400",
  red: "bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400",
  sky: "bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-400",
} as const;

export type BadgeTone = keyof typeof TONE_CLS;

/** Pill status badge with a leading dot — the recurring status-chip pattern used across campaign/lead tables. */
export default function Badge({
  label,
  tone = "slate",
  dot = true,
}: {
  label: string;
  tone?: BadgeTone;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] font-semibold whitespace-nowrap ${TONE_CLS[tone]}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}
