import { AppIcon } from "@/components/brand/Logo";
import { AuthShowcase } from "./AuthShowcase";

/**
 * The frame every auth page shares: the form centred on the left — app
 * icon, title, the page's fields, a footer line — and AuthShowcase on the
 * right from the lg breakpoint. Auth pages are always dark; they do not follow
 * the app theme.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-[#0b0b0d] text-zinc-100 scheme-dark">
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-100">
          <div className="mb-7 flex justify-center">
            <AppIcon className="size-12" />
          </div>
          <h1 className="text-center text-[26px] font-semibold leading-tight tracking-[-0.02em] text-white">{title}</h1>
          {subtitle && <p className="mt-2 text-center text-sm text-zinc-400">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-center text-sm text-zinc-400">{footer}</div>}
        </div>
      </main>
      <aside className="hidden flex-1 p-3 lg:block">
        <AuthShowcase />
      </aside>
    </div>
  );
}
