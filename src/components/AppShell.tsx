"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { RiMenuLine } from "@remixicon/react";

import { Logo } from "@/components/brand/Logo";
import Sidebar from "@/components/Sidebar";
import { SessionGate } from "@/components/auth/SessionGate";
import { DemoBanner } from "@/components/demo/DemoProvider";
import { BRAND } from "@/lib/brand";

const CHROMELESS_ROUTES = [
  "/login",
  "/unsubscribe",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/onboarding",
  "/accept-invitation",
  // First-run setup: no session exists yet, so SessionGate would send the
  // visitor to /sign-in, which sends a fresh instance straight back here.
  "/setup",
];

/** The public homepage and sign-in screens have no workspace chrome. */
export function isChromeless(pathname: string) {
  return pathname === "/" || CHROMELESS_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * The signed-in frame: the sidebar beside the page from `md` up; below it,
 * a slim top bar whose menu button opens the same sidebar as a drawer, so a
 * phone gets the full page width.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Close the drawer when a link in it navigates (derived during render, not in an effect).
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setDrawerOpen(false);
  }

  if (isChromeless(pathname)) return children;

  return (
    <SessionGate>
    <div className="app-workspace flex h-dvh min-h-0 flex-col overflow-hidden bg-bg-white-0">
    <DemoBanner />
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="hidden h-full md:flex">
        <Sidebar />
      </div>

      <header className="flex h-12 shrink-0 items-center justify-between border-b border-stroke-soft-200 bg-bg-white-0 px-4 md:hidden">
        <Link href="/assistant" aria-label={`${BRAND.name} home`}>
          <Logo className="text-text-strong-950" iconClassName="size-7" textClassName="text-[15px]" />
        </Link>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="flex size-9 items-center justify-center rounded-lg text-text-sub-600 outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base"
        >
          <RiMenuLine className="size-5" />
        </button>
      </header>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 w-[288px] max-w-[85vw] shadow-regular-md outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-left md:hidden"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Sidebar mobile onClose={() => setDrawerOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* `relative` is load-bearing: Tailwind's `sr-only` is `position:absolute`
          with no offsets, so without a positioned ancestor those elements
          resolve against the initial containing block, escape this scroller's
          clipping, and stretch the document's scroll area to the full content
          height — leaving a tall blank band below the app. */}
      <div className="workspace-canvas relative min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
    </div>
    </SessionGate>
  );
}
