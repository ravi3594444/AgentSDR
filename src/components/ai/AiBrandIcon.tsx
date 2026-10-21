import {
  RiAmazonFill,
  RiAnthropicFill,
  RiDeepseekFill,
  RiGoogleFill,
  RiMetaFill,
  RiMicrosoftFill,
  RiOpenaiFill,
  RiQwenAiFill,
  RiTwitterXFill,
} from "@remixicon/react";

type Brand =
  | "azure"
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "qwen"
  | "meta"
  | "amazon"
  | "microsoft"
  | "xai"
  | "fallback";

function brandFor(identifier: string): Brand {
  const value = identifier.trim().toLowerCase();
  const owner = value.split("/", 1)[0];
  if (value === "azure") return "azure";
  if (owner === "openai") return "openai";
  if (owner === "anthropic") return "anthropic";
  if (owner === "google" || value.includes("google") || value.includes("vertex")) return "google";
  if (owner === "deepseek") return "deepseek";
  if (owner === "qwen" || owner === "alibaba") return "qwen";
  if (owner === "meta-llama" || owner === "meta") return "meta";
  if (owner === "amazon" || value.includes("bedrock") || value === "aws") return "amazon";
  if (owner === "microsoft") return "microsoft";
  if (owner === "x-ai" || owner === "xai") return "xai";
  return "fallback";
}

function AzureMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 242" className={className} aria-hidden="true">
      <path fill="#114A8B" d="M85.343.003h75.753L82.457 233a12.08 12.08 0 0 1-11.442 8.216H12.06A12.06 12.06 0 0 1 .633 225.303L73.898 8.219A12.08 12.08 0 0 1 85.343 0z" />
      <path fill="#0078D4" d="M195.423 156.282H75.297a5.56 5.56 0 0 0-3.796 9.627l77.19 72.047a12.14 12.14 0 0 0 8.28 3.26h68.02z" />
      <path fill="#2892DF" d="M182.098 8.207A12.06 12.06 0 0 0 170.67.003H86.245c5.175 0 9.773 3.301 11.428 8.204L170.94 225.3a12.062 12.062 0 0 1-11.428 15.92h84.429a12.062 12.062 0 0 0 11.425-15.92z" />
    </svg>
  );
}

const brandStyles: Record<Brand, string> = {
  azure: "bg-sky-50 dark:bg-sky-500/10 text-[#0078D4] ring-sky-100 dark:ring-sky-500/20",
  openai: "bg-bg-weak-50 text-text-strong-950 ring-stroke-soft-200",
  anthropic: "bg-[#F7EEE9] text-[#C15F3C] ring-[#EAD7CC] dark:bg-[#C15F3C]/15 dark:text-[#E08A66] dark:ring-[#C15F3C]/30",
  google: "bg-blue-50 dark:bg-blue-500/10 text-[#4285F4] ring-blue-100 dark:ring-blue-500/20",
  deepseek: "bg-blue-50 dark:bg-blue-500/10 text-[#4D6BFE] ring-blue-100 dark:ring-blue-500/20",
  qwen: "bg-violet-50 dark:bg-violet-500/10 text-[#615CED] ring-violet-100 dark:ring-violet-500/20",
  meta: "bg-blue-50 dark:bg-blue-500/10 text-[#0866FF] ring-blue-100 dark:ring-blue-500/20",
  amazon: "bg-amber-50 dark:bg-amber-500/10 text-[#FF9900] ring-amber-100 dark:ring-amber-500/20",
  microsoft: "bg-sky-50 dark:bg-sky-500/10 text-[#00A4EF] ring-sky-100 dark:ring-sky-500/20",
  xai: "bg-bg-weak-50 text-text-strong-950 ring-stroke-soft-200",
  fallback: "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200",
};

export function AiBrandIcon({
  identifier,
  label,
  className = "size-8",
}: {
  identifier: string;
  label: string;
  className?: string;
}) {
  const brand = brandFor(identifier);
  const iconClass = "size-[62%]";
  let mark: React.ReactNode;
  switch (brand) {
    case "azure": mark = <AzureMark className={iconClass} />; break;
    case "openai": mark = <RiOpenaiFill className={iconClass} />; break;
    case "anthropic": mark = <RiAnthropicFill className={iconClass} />; break;
    case "google": mark = <RiGoogleFill className={iconClass} />; break;
    case "deepseek": mark = <RiDeepseekFill className={iconClass} />; break;
    case "qwen": mark = <RiQwenAiFill className={iconClass} />; break;
    case "meta": mark = <RiMetaFill className={iconClass} />; break;
    case "amazon": mark = <RiAmazonFill className={iconClass} />; break;
    case "microsoft": mark = <RiMicrosoftFill className={iconClass} />; break;
    case "xai": mark = <RiTwitterXFill className={iconClass} />; break;
    default: mark = <span className="text-[12px] font-bold leading-none">{label.trim().slice(0, 1).toUpperCase() || "AI"}</span>;
  }

  return (
    <span
      title={label}
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${brandStyles[brand]} ${className}`}
    >
      {mark}
    </span>
  );
}
