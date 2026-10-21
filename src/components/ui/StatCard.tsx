const TREND_CLS = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  neutral: "text-text-strong-950/40",
} as const;

export default function StatCard({
  label,
  value,
  trend,
}: {
  label: string;
  value: string | number;
  trend?: { label: string; direction: keyof typeof TREND_CLS };
}) {
  return (
    <div className="bg-bg-white-0 border border-stroke-soft-200 rounded-2xl px-4 py-3.5">
      <p className="text-[13px] text-text-strong-950/45 mb-1.5">{label}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-xl font-bold text-text-strong-950">{value}</p>
        {trend && <span className={`text-[13px] font-semibold ${TREND_CLS[trend.direction]}`}>{trend.label}</span>}
      </div>
    </div>
  );
}
