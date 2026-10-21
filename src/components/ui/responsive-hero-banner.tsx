"use client";

import { useState } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

interface NavLink {
  label: string;
  href: string;
  isActive?: boolean;
}

interface Partner {
  logoUrl: string;
  href: string;
  name?: string;
}

interface ResponsiveHeroBannerProps {
  logoUrl?: string;
  backgroundImageUrl?: string;
  navLinks?: NavLink[];
  ctaButtonText?: string;
  ctaButtonHref?: string;
  badgeText?: string;
  badgeLabel?: string;
  title?: string;
  titleLine2?: string;
  description?: string;
  primaryButtonText?: string;
  primaryButtonHref?: string;
  secondaryButtonText?: string;
  secondaryButtonHref?: string;
  partnersTitle?: string;
  partners?: Partner[];
}

const defaultNavLinks: NavLink[] = [
  { label: "Overview", href: "#product", isActive: true },
  { label: "Workflow", href: "#workflow" },
  { label: "Open source", href: "#open-source" },
  { label: "Questions", href: "#faq" },
];

const defaultPartners: Partner[] = [
  { name: "POSTGRES", logoUrl: "", href: "#open-source" },
  { name: "OPENROUTER", logoUrl: "", href: "#enrich" },
  { name: "GMAIL", logoUrl: "", href: "#outreach" },
  { name: "LINKEDIN", logoUrl: "", href: "#outreach" },
  { name: "UNIPILE", logoUrl: "", href: "#outreach" },
];

export default function ResponsiveHeroBanner({
  logoUrl = "/icon.svg",
  backgroundImageUrl = "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=2400&q=88",
  navLinks = defaultNavLinks,
  ctaButtonText = "Open workspace",
  ctaButtonHref = "/domains",
  badgeLabel = "Open source",
  badgeText = "Self-host the full outbound workflow",
  title = "One system from target account",
  titleLine2 = "to next action.",
  description = "Find companies, enrich account data, run email and LinkedIn campaigns, and review every reply in one workspace your team can inspect and change.",
  primaryButtonText = "View the source",
  primaryButtonHref = "https://github.com/Kandid-ai/AgentSDR",
  secondaryButtonText = "See the workflow",
  secondaryButtonHref = "#workflow",
  partnersTitle = "The infrastructure behind your outbound motion",
  partners = defaultPartners,
}: ResponsiveHeroBannerProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <section className="relative isolate min-h-[760px] w-full overflow-hidden bg-neutral-950 text-white lg:min-h-screen">
      <div
        aria-hidden="true"
        className="absolute inset-0 scale-[1.01] bg-cover bg-center"
        style={{ backgroundImage: `url(${backgroundImageUrl})` }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,8,8,.46)_0%,rgba(7,8,8,.36)_35%,rgba(7,8,8,.9)_100%),linear-gradient(90deg,rgba(7,8,8,.24),transparent_48%,rgba(7,8,8,.18))]" />
      <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-black/30" />

      <header className="relative z-20 border-b border-white/12">
        <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between px-6">
          <Link href="/" className="inline-flex items-center" aria-label={`${BRAND.name} home`}>
            <span
              aria-hidden="true"
              className="h-9 w-[138px] bg-contain bg-left bg-no-repeat"
              style={{ backgroundImage: `url(${logoUrl})` }}
            />
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
            <div className="flex items-center gap-1 rounded-full bg-black/15 p-1 ring-1 ring-white/15 backdrop-blur-xl">
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  aria-current={link.isActive ? "location" : undefined}
                  className={`rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                    link.isActive ? "bg-white/10 text-white" : "text-white/70 hover:text-white"
                  }`}
                >
                  {link.label}
                </a>
              ))}
              <a
                href={ctaButtonHref}
                className="ml-1 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-neutral-900 transition-colors hover:bg-white/90"
              >
                {ctaButtonText}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </nav>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="inline-flex size-10 items-center justify-center rounded-full bg-black/15 text-white ring-1 ring-white/20 backdrop-blur-xl md:hidden"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-hero-navigation"
            aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <nav
            id="mobile-hero-navigation"
            className="absolute inset-x-4 top-[62px] grid gap-1 rounded-2xl bg-neutral-950/95 p-3 shadow-2xl ring-1 ring-white/15 backdrop-blur-xl md:hidden"
            aria-label="Mobile navigation"
          >
            {navLinks.map((link) => (
              <a key={link.label} href={link.href} onClick={() => setMobileMenuOpen(false)} className="rounded-xl px-4 py-3 text-sm text-white/80 hover:bg-white/10 hover:text-white">
                {link.label}
              </a>
            ))}
            <a href={ctaButtonHref} className="mt-1 inline-flex items-center justify-between rounded-xl bg-white px-4 py-3 text-sm font-semibold text-neutral-900">
              {ctaButtonText}<ArrowUpRight className="size-4" />
            </a>
          </nav>
        )}
      </header>

      <div className="relative z-10 mx-auto flex min-h-[688px] max-w-7xl flex-col justify-between px-6 pb-10 pt-24 sm:pt-28 lg:min-h-[calc(100vh-72px)] lg:pt-32">
        <div className="mx-auto max-w-4xl text-center">
          <div className="animate-fade-slide-in-1 mb-7 inline-flex items-center gap-3 rounded-full bg-black/20 p-1.5 pr-4 ring-1 ring-white/20 backdrop-blur-xl">
            <span className="rounded-full bg-white px-2.5 py-1 text-[13px] font-semibold text-neutral-900">{badgeLabel}</span>
            <span className="text-sm font-medium text-white/85">{badgeText}</span>
          </div>

          <h1 className="animate-fade-slide-in-2 font-instrument-serif text-5xl font-normal leading-[.95] tracking-[-.035em] text-white sm:text-6xl md:text-7xl lg:text-[88px]">
            {title}
            <br className="hidden sm:block" />
            {" "}{titleLine2}
          </h1>

          <p className="animate-fade-slide-in-3 mx-auto mt-7 max-w-2xl text-base leading-7 text-white/72 sm:text-lg">
            {description}
          </p>

          <div className="animate-fade-slide-in-4 mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
            <a href={primaryButtonHref} target={primaryButtonHref.startsWith("http") ? "_blank" : undefined} rel={primaryButtonHref.startsWith("http") ? "noreferrer" : undefined} className="inline-flex min-h-12 items-center gap-3 rounded-full bg-white px-5 text-sm font-semibold text-neutral-950 transition-transform hover:-translate-y-0.5">
              {primaryButtonText}<ArrowRight className="size-4" aria-hidden="true" />
            </a>
            <a href={secondaryButtonHref} className="inline-flex min-h-12 items-center gap-3 rounded-full bg-white/8 px-5 text-sm font-semibold text-white ring-1 ring-white/18 backdrop-blur transition-colors hover:bg-white/14">
              {secondaryButtonText}<ArrowDown className="size-4" aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="mx-auto mt-20 w-full max-w-5xl">
          <p className="animate-fade-slide-in-3 text-center text-xs font-medium uppercase tracking-[.15em] text-white/55">{partnersTitle}</p>
          <div className="animate-fade-slide-in-4 mt-6 grid grid-cols-2 border-y border-white/15 sm:grid-cols-3 md:grid-cols-5">
            {partners.map((partner, index) => (
              <a
                key={partner.name ?? partner.logoUrl}
                href={partner.href}
                aria-label={partner.name ?? `Partner ${index + 1}`}
                className="flex h-16 items-center justify-center border-r border-white/15 text-[13px] font-semibold tracking-[.12em] text-white/65 transition-colors last:border-r-0 hover:bg-white/5 hover:text-white"
              >
                {partner.logoUrl ? (
                  <span aria-hidden="true" className="h-8 w-28 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url(${partner.logoUrl})` }} />
                ) : partner.name}
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
