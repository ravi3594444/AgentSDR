"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiBookOpenLine,
  RiBugLine,
  RiCheckLine,
  RiCloseLine,
  RiExternalLinkLine,
  RiLightbulbLine,
  RiLogoutBoxRLine,
  RiMore2Line,
  RiQuestionLine,
  RiSearchLine,
  RiSettings3Line,
  RiShieldCheckLine,
  RiSideBarLine,
  RiChat3Line,
} from "@remixicon/react";

import { AppIcon, Logo } from "@/components/brand/Logo";
import { authClient, useActiveOrganization, useListOrganizations, useSession } from "@/lib/auth/client";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Tooltip from "@/components/alignui/tooltip";
import { SETTINGS_HOME } from "@/components/settings/settingsNav";
import { CommandPalette } from "@/components/nav/CommandPalette";
import { ThemeToggleButton } from "@/components/theme/ThemeSwitch";
import { activeHref, NAV_FOOTER, visibleNavSections, type NavBadges, type NavData, type NavEntry, type NavGroup, type NavLink } from "@/components/nav/navConfig";
import type { FeatureState } from "@/lib/features/catalog";
import { APP_VERSION, bugReportUrl, SUPPORT_LINKS } from "@/lib/support";
import { useDemoMode } from "@/components/demo/DemoProvider";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";
import { useRecordChanged } from "@/components/crm/recordEvents";

/**
 * The app sidebar, in the ReUI shape: brand + collapse at the top, a
 * "jump to" search (⌘K), labelled sections with one collapsible group per
 * outreach channel, developer links and Settings pinned to the bottom, and
 * the workspace card. Collapses to an icon rail; groups then open as a menu.
 *
 * Badges are live (GET /api/nav/badges): refreshed on navigation and every
 * minute while the tab is visible. The same answer says which optional
 * features are on; an entry tied to one (Instagram) shows only then.
 */

const COLLAPSED_KEY = "agentsdr-sidebar-collapsed";
const OPEN_KEY = "agentsdr-sidebar-open-groups";

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the sidebar still works, it just forgets.
  }
}

function useBadges(pathname: string): { badges: NavBadges | null; features: FeatureState | null } {
  const [badges, setBadges] = useState<NavBadges | null>(null);
  const [features, setFeatures] = useState<FeatureState | null>(null);
  const load = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    fetch("/api/nav/badges", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Partial<NavData> | null) => {
        if (!b) return;
        const { features: next, ...counts } = b;
        setBadges(counts as NavBadges);
        if (next) setFeatures(next);
      })
      .catch(() => {});
  }, []);
  useRecordChanged(load);
  useEffect(() => {
    load();
  }, [load, pathname]);
  useEffect(() => {
    const id = window.setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, [load]);
  return { badges, features };
}

function Badge({ link, badges, collapsed }: { link: NavLink; badges: NavBadges | null; collapsed?: boolean }) {
  const value = link.badge && badges ? badges[link.badge] : 0;
  if (!value) return null;
  if (collapsed || link.badgeStyle === "dot") {
    return <span aria-label={`${value} need attention`} className={cn("size-2 shrink-0 rounded-full bg-warning-base", collapsed && "absolute right-1.5 top-1.5 ring-2 ring-bg-white-0")} />;
  }
  return (
    <span className="ml-auto shrink-0 rounded-md bg-bg-weak-50 px-1.5 py-0.5 text-label-xs tabular-nums text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
      {value > 999 ? "999+" : value.toLocaleString("en-US")}
    </span>
  );
}

const rowBase = "flex w-full items-center gap-2.5 rounded-lg text-label-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary-base";
const rowState = (active: boolean) => (active ? "bg-bg-strong-950 text-text-white-0" : "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950");

function RailTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Content side="right" sideOffset={10}>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

function LinkRow({ link, active, badges, collapsed, compact }: { link: NavLink; active: boolean; badges: NavBadges | null; collapsed: boolean; compact?: boolean }) {
  const Icon = link.icon;
  if (collapsed) {
    return (
      <RailTip label={link.label}>
        <Link href={link.href} aria-label={link.label} aria-current={active ? "page" : undefined} className={cn(rowBase, rowState(active), "relative h-9 justify-center")}>
          <Icon className={cn("size-[18px] shrink-0", active ? "text-text-white-0" : "text-text-soft-400")} />
          <Badge link={link} badges={badges} collapsed />
        </Link>
      </RailTip>
    );
  }
  return (
    <Link href={link.href} aria-current={active ? "page" : undefined} className={cn(rowBase, rowState(active), compact ? "h-8 px-2 text-paragraph-sm" : "h-9 px-2")}>
      <Icon className={cn("shrink-0", compact ? "size-4" : "size-[18px]", active ? "text-text-white-0" : "text-text-soft-400")} />
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      <Badge link={link} badges={badges} />
    </Link>
  );
}

const HELP_LINKS = [
  { label: "Documentation", href: SUPPORT_LINKS.docs, icon: RiBookOpenLine },
  { label: "Report a bug", href: bugReportUrl(APP_VERSION), icon: RiBugLine },
  { label: "Request a feature", href: SUPPORT_LINKS.featureRequest, icon: RiLightbulbLine },
  { label: "Ask the community", href: SUPPORT_LINKS.community, icon: RiChat3Line },
  { label: "Report a security issue", href: SUPPORT_LINKS.security, icon: RiShieldCheckLine },
];

/** Help: a menu of external links (docs, bug, feature, community, security), each in a new tab. */
function HelpRow({ collapsed, compact }: { collapsed: boolean; compact?: boolean }) {
  return (
    <Dropdown.Root>
      {collapsed ? (
        <RailTip label="Help">
          <Dropdown.Trigger asChild>
            <button type="button" aria-label="Help" className={cn(rowBase, rowState(false), "h-9 justify-center")}>
              <RiQuestionLine className="size-[18px] shrink-0 text-text-soft-400" />
            </button>
          </Dropdown.Trigger>
        </RailTip>
      ) : (
        <Dropdown.Trigger asChild>
          <button type="button" className={cn(rowBase, rowState(false), compact ? "h-8 px-2 text-paragraph-sm" : "h-9 px-2")}>
            <RiQuestionLine className={cn("shrink-0 text-text-soft-400", compact ? "size-4" : "size-[18px]")} />
            <span className="min-w-0 flex-1 truncate text-left">Help</span>
          </button>
        </Dropdown.Trigger>
      )}
      <Dropdown.Content side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} sideOffset={collapsed ? 10 : undefined} className="w-56">
        <p className="px-2 pb-1 pt-1.5 text-paragraph-xs text-text-soft-400">Help</p>
        {HELP_LINKS.map((l) => (
          <Dropdown.Item key={l.href} asChild>
            <a href={l.href} target="_blank" rel="noopener noreferrer">
              <Dropdown.ItemIcon as={l.icon} />
              <span className="flex-1">{l.label}</span>
              <RiExternalLinkLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
            </a>
          </Dropdown.Item>
        ))}
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

function GroupIcon({ group, className }: { group: NavGroup; className?: string }) {
  const Icon = group.icon;
  return (
    <span className="flex shrink-0 text-current">
      <Icon className={className} />
    </span>
  );
}

function GroupRow({ group, current, open, onToggle, badges, collapsed, compact }: { group: NavGroup; current: string | undefined; open: boolean; onToggle: () => void; badges: NavBadges | null; collapsed: boolean; compact?: boolean }) {
  const holdsActive = group.children.some((c) => c.href === current);
  const childBadge = group.children.reduce((sum, c) => sum + (c.badge && badges ? badges[c.badge] : 0), 0);

  if (collapsed) {
    return (
      <Dropdown.Root>
        <RailTip label={group.label}>
          <Dropdown.Trigger asChild>
            <button type="button" aria-label={group.label} className={cn(rowBase, rowState(holdsActive), "relative h-9 justify-center")}>
              <GroupIcon group={group} className="size-[18px]" />
              {childBadge > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-warning-base ring-2 ring-bg-white-0" />}
            </button>
          </Dropdown.Trigger>
        </RailTip>
        <Dropdown.Content side="right" align="start" sideOffset={10} className="w-52">
          <p className="px-2 pb-1 pt-1.5 text-paragraph-xs text-text-soft-400">{group.label}</p>
          {group.children.map((c) => (
            <Dropdown.Item key={c.href} asChild className={cn(c.href === current && "bg-bg-weak-50 text-text-strong-950")}>
              <Link href={c.href}>
                <Dropdown.ItemIcon as={c.icon} />
                <span className="flex-1">{c.label}</span>
                <Badge link={c} badges={badges} />
              </Link>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Root>
    );
  }

  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={cn(rowBase, rowState(false), compact ? "h-8 px-2 text-paragraph-sm" : "h-9 px-2", holdsActive && !open && "text-text-strong-950")}>
        <GroupIcon group={group} className={compact ? "size-4" : "size-[18px]"} />
        <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        {!open && childBadge > 0 && <span className="size-2 shrink-0 rounded-full bg-warning-base" aria-label="Needs attention" />}
        <RiArrowDownSLine className={cn("size-4 shrink-0 text-text-soft-400 transition-transform duration-200", !open && "-rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <ul className="mt-0.5 space-y-0.5 pl-3">
          {group.children.map((c) => {
            const active = c.href === current;
            const ChildIcon = c.icon;
            return (
              <li key={c.href}>
                <Link href={c.href} aria-current={active ? "page" : undefined} className={cn(rowBase, rowState(active), "h-8 gap-2 px-2 text-paragraph-sm", active && "text-label-sm")}>
                  <ChildIcon className={cn("size-4 shrink-0", active ? "text-text-white-0" : "text-text-soft-400")} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <Badge link={c} badges={badges} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Sidebar({ mobile = false, onClose }: { mobile?: boolean; onClose?: () => void } = {}) {
  const pathname = usePathname();
  const current = activeHref(pathname);
  const { badges, features } = useBadges(pathname);
  const sections = useMemo(() => visibleNavSections(features), [features]);
  const [storedCollapsed, setCollapsed] = useState(false);
  // The phone drawer is always the full sidebar.
  const collapsed = !mobile && storedCollapsed;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Stored preferences load after mount (the server can't read them).
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCollapsed(readStorage(COLLAPSED_KEY, false));
      setOpenGroups(readStorage(OPEN_KEY, {}));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    // The desktop sidebar (always mounted) owns the shortcut; a drawer copy would double-toggle it.
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeStorage(COLLAPSED_KEY, !c);
      return !c;
    });
  };

  // A group holding the current page is always open; otherwise the stored choice, else its default.
  const isOpen = (g: NavGroup) => g.children.some((c) => c.href === current) || (openGroups[g.id] ?? Boolean(g.defaultOpen));
  const toggleGroup = (g: NavGroup) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [g.id]: !isOpen(g) };
      writeStorage(OPEN_KEY, next);
      return next;
    });
  };

  const { data: session, isPending: sessionPending } = useSession();
  const { data: activeOrg, isPending: orgPending } = useActiveOrganization();
  const { data: orgs } = useListOrganizations();
  const demo = useDemoMode();
  const [switchError, setSwitchError] = useState("");
  const wsLoading = sessionPending || orgPending;
  const wsName = activeOrg?.name ?? "No organization";
  const wsUser = session?.user.name || session?.user.email || "";

  async function switchOrg(organizationId: string) {
    if (organizationId === activeOrg?.id) return;
    setSwitchError("");
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) return setSwitchError(error.message || "Could not switch organization.");
    // A full load, so nothing cached from the previous organization survives.
    window.location.assign("/analytics");
  }

  async function signOut() {
    await authClient.signOut();
    // A full load, so nothing cached in the page outlives the session.
    window.location.replace("/sign-in");
  }

  const renderEntry = (e: NavEntry, compact?: boolean) =>
    e.kind === "link" ? (
      <LinkRow key={e.href} link={e} active={e.href === current} badges={badges} collapsed={collapsed} compact={compact} />
    ) : (
      <GroupRow key={e.id} group={e} current={current} open={isOpen(e)} onToggle={() => toggleGroup(e)} badges={badges} collapsed={collapsed} compact={compact} />
    );

  return (
    <Tooltip.Provider delayDuration={200}>
      <aside className={cn("workspace-sidebar flex h-full shrink-0 flex-col bg-bg-white-0", mobile ? "w-full" : "border-r border-stroke-soft-200 transition-[width] duration-200 ease-out", !mobile && (collapsed ? "w-[68px]" : "w-64"))}>
        {/* Brand + collapse */}
        <div className={cn("flex h-18 shrink-0 items-center", collapsed ? "justify-center" : "justify-between pl-4 pr-2.5")}>
          {!collapsed && (
            <Link href="/assistant" aria-label={`${BRAND.name} home`} className="group rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
              <Logo className="text-text-strong-950" />
            </Link>
          )}
          <div className={cn("flex items-center", collapsed && "hidden")}>
          <RailTip label="Light or dark">
            <span><ThemeToggleButton /></span>
          </RailTip>
          {mobile ? (
            <button type="button" onClick={onClose} aria-label="Close menu" className="flex size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base">
              <RiCloseLine className="size-5" />
            </button>
          ) : (
          <RailTip label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} className="flex size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base">
              <RiSideBarLine className="size-[18px]" />
            </button>
          </RailTip>
          )}
          </div>
          {/* Collapsed, the brand stays as its app tile, linking home. */}
          {collapsed && (
            <Link href="/assistant" aria-label={`${BRAND.name} home`} className="group rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
              <AppIcon small className="size-7" />
            </Link>
          )}
        </div>

        {/* Collapsed: the expand control, always visible under the brand. */}
        {collapsed && (
          <div className="shrink-0 px-3 pb-2">
            <RailTip label="Expand sidebar">
              <button type="button" onClick={toggleCollapsed} aria-label="Expand sidebar" aria-expanded={false} className={cn(rowBase, rowState(false), "h-9 justify-center")}>
                <RiSideBarLine className="size-[18px] text-text-soft-400" />
              </button>
            </RailTip>
          </div>
        )}

        {/* Jump to */}
        <div className={cn("shrink-0 pb-2", collapsed ? "px-3" : "px-3")}>
          {collapsed ? (
            <RailTip label="Search (⌘K)">
              <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Search or jump to" className={cn(rowBase, rowState(false), "h-9 justify-center")}>
                <RiSearchLine className="size-[18px] text-text-soft-400" />
              </button>
            </RailTip>
          ) : (
            <button type="button" onClick={() => setPaletteOpen(true)} className="flex h-9 w-full items-center gap-2 rounded-lg bg-bg-white-0 px-2.5 text-paragraph-sm text-text-soft-400 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base">
              <RiSearchLine className="size-4 shrink-0" />
              <span className="flex-1 text-left">Search or jump to…</span>
              <kbd className="rounded bg-bg-weak-50 px-1.5 text-label-xs text-text-soft-400 ring-1 ring-inset ring-stroke-soft-200">⌘K</kbd>
            </button>
          )}
        </div>

        {/* Sections */}
        <nav aria-label="Main" className={cn("flex-1 overflow-y-auto pb-3", collapsed ? "px-3" : "px-3")}>
          {sections.map((section, i) => (
            <div key={section.label ?? i} className={cn(i > 0 && "mt-4")}>
              {section.label && (collapsed ? <div className="mx-2 mb-2 border-t border-stroke-soft-200" /> : <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-soft-400">{section.label}</p>)}
              <div className="space-y-0.5">{section.entries.map((e) => renderEntry(e))}</div>
            </div>
          ))}
        </nav>

        {/* Pinned: developer links, settings, workspace */}
        <div className={cn("shrink-0 space-y-0.5 border-t border-stroke-soft-200 pt-2", collapsed ? "px-3" : "px-3")}>
          {NAV_FOOTER.map((e) => renderEntry(e, true))}
          <HelpRow collapsed={collapsed} compact />
        </div>
        <div className={cn("shrink-0 p-3", collapsed && "flex justify-center")}>
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <button type="button" aria-label="Workspace menu" className={cn("flex items-center gap-2.5 rounded-xl text-left outline-none transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base", collapsed ? "size-9 justify-center" : "w-full p-2 ring-1 ring-inset ring-stroke-soft-200")}>
                <AppIcon small className="size-8" />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1">
                      {wsLoading ? (
                        <>
                          <span className="block h-3.5 w-24 animate-pulse rounded bg-bg-soft-200" />
                          <span className="mt-1.5 block h-3 w-32 animate-pulse rounded bg-bg-soft-200" />
                        </>
                      ) : (
                        <>
                          <span className="block truncate text-label-sm text-text-strong-950">{wsName}</span>
                          <span className="block truncate text-paragraph-xs text-text-sub-600">{wsUser}</span>
                        </>
                      )}
                    </span>
                    <RiMore2Line className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
                  </>
                )}
              </button>
            </Dropdown.Trigger>
            <Dropdown.Content side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} className="w-64">
              <div className="px-2 pb-1.5 pt-1.5">
                <p className="truncate text-label-sm text-text-strong-950">{wsUser || "Account"}</p>
                {session?.user.email && session.user.name && <p className="truncate text-paragraph-xs text-text-sub-600">{session.user.email}</p>}
              </div>
              <Dropdown.Separator />
              <p className="px-2 pb-1 pt-1.5 text-paragraph-xs text-text-soft-400">Organizations</p>
              {(orgs ?? []).map((o) => (
                <Dropdown.Item key={o.id} onSelect={() => void switchOrg(o.id)}>
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {o.id === activeOrg?.id && <RiCheckLine className="size-4 shrink-0 text-text-strong-950" aria-label="Active" />}
                </Dropdown.Item>
              ))}
              {switchError && <p role="alert" className="px-2 py-1 text-paragraph-xs text-error-base">{switchError}</p>}
              {!demo && (
                <Dropdown.Item asChild>
                  <Link href="/onboarding?new=1">
                    <Dropdown.ItemIcon as={RiAddLine} />
                    Create organization
                  </Link>
                </Dropdown.Item>
              )}
              <Dropdown.Separator />
              <Dropdown.Item asChild>
                <Link href={SETTINGS_HOME}>
                  <Dropdown.ItemIcon as={RiSettings3Line} />
                  Settings
                </Link>
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => setPaletteOpen(true)}>
                <Dropdown.ItemIcon as={RiSearchLine} />
                Search or jump to
                <span className="ml-auto text-paragraph-xs text-text-soft-400">⌘K</span>
              </Dropdown.Item>
              <Dropdown.Item asChild>
                <Link href="/">
                  <Dropdown.ItemIcon as={RiExternalLinkLine} />
                  Product website
                </Link>
              </Dropdown.Item>
              {/* The demo signs every visitor in as the demo user; there is nothing to sign out of. */}
              {!demo && (
                <>
                  <Dropdown.Separator />
                  <Dropdown.Item onSelect={() => void signOut()}>
                    <Dropdown.ItemIcon as={RiLogoutBoxRLine} />
                    Sign out
                  </Dropdown.Item>
                </>
              )}
            </Dropdown.Content>
          </Dropdown.Root>
        </div>
      </aside>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} features={features} />
    </Tooltip.Provider>
  );
}
