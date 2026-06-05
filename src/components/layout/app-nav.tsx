"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { HomeSummaryPayload } from "@/lib/home/summary";
import {
  activeSection,
  canAccessHref,
  HOME_HREF,
  isActivePath,
  visibleSections,
  type NavBadgeKey,
  type NavSectionId,
  type NavTool,
} from "@/lib/navigation/tools";
import { cn } from "@/lib/utils";

function navLinkClass(isActive: boolean) {
  return cn(
    "inline-flex h-8 items-center rounded-md px-3 text-sm transition-colors",
    isActive
      ? "bg-primary/10 font-medium text-primary"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
}

function badgeValue(summary: HomeSummaryPayload | null, badgeKey: NavBadgeKey | undefined): number {
  if (!badgeKey) return 0;
  const item = summary?.actions.find((action) => action.id === badgeKey);
  return item?.status === "ok" ? item.value ?? 0 : 0;
}

function ToolBadge({ value }: { value: number }) {
  if (value <= 0) return null;
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 px-1.5 text-amber-900">
      {value}
    </Badge>
  );
}

function ToolLink({
  item,
  active,
  count,
  onClick,
}: {
  item: NavTool;
  active: boolean;
  count: number;
  onClick?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "flex min-h-16 items-start justify-between gap-3 rounded-md border p-3 transition-colors",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-transparent hover:border-border hover:bg-muted/70",
      )}
    >
      <span className="min-w-0">
        <span className={cn("block text-sm font-medium", active ? "text-primary" : "text-foreground")}>
          {item.label}
        </span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">{item.description}</span>
      </span>
      <ToolBadge value={count} />
    </Link>
  );
}

export function AppNav({ allowedPages }: { allowedPages: string[] | null }) {
  const pathname = usePathname();
  const [openSection, setOpenSection] = useState<NavSectionId | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const sections = useMemo(() => visibleSections(allowedPages), [allowedPages]);
  const activeSectionId = activeSection(pathname, allowedPages);
  const canAccessHome = canAccessHref(HOME_HREF, allowedPages);
  const brandHref = canAccessHome ? HOME_HREF : allowedPages?.[0] ?? HOME_HREF;
  const hasBadgedTools = sections.some((section) => section.tools.some((tool) => tool.badgeKey));
  const badgeSummary = hasBadgedTools ? summary : null;

  useEffect(() => {
    if (!hasBadgedTools) {
      return;
    }
    const controller = new AbortController();
    fetch("/api/home/summary", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: HomeSummaryPayload | null) => setSummary(payload))
      .catch(() => undefined);
    return () => controller.abort();
  }, [hasBadgedTools]);

  function sectionBadgeTotal(sectionId: NavSectionId) {
    const section = sections.find((item) => item.id === sectionId);
    return section?.tools.reduce((total, tool) => total + badgeValue(badgeSummary, tool.badgeKey), 0) ?? 0;
  }

  return (
    <nav className="flex h-11 flex-shrink-0 items-center overflow-x-auto border-b border-border bg-card px-4 [scrollbar-width:none] lg:px-6 [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max flex-1 items-center gap-4">
        <Link href={brandHref} className="text-sm font-semibold tracking-tight text-primary">
          BeGifted Ops
        </Link>
        <div className="hidden items-center gap-1 md:flex">
          {canAccessHome && (
            <Link href={HOME_HREF} className={navLinkClass(pathname === HOME_HREF)}>
              Home
            </Link>
          )}
          {sections.map((section) => {
            const sectionActive = activeSectionId === section.id;
            const total = sectionBadgeTotal(section.id);
            return (
              <Popover
                key={section.id}
                open={openSection === section.id}
                onOpenChange={(open) => setOpenSection(open ? section.id : null)}
              >
                <PopoverTrigger
                  render={(props) => (
                    <Button
                      {...props}
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 gap-1.5 rounded-md px-3 text-sm",
                        sectionActive
                          ? "bg-primary/10 font-medium text-primary hover:bg-primary/10"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {section.label}
                      <ToolBadge value={total} />
                      <ChevronDown
                        aria-hidden="true"
                        className={cn("size-3.5 transition-transform", openSection === section.id && "rotate-180")}
                      />
                    </Button>
                  )}
                />
                <PopoverContent className="w-[min(42rem,calc(100vw-2rem))] p-3" align="start">
                  <div className="mb-3">
                    <div className="text-sm font-medium text-foreground">{section.label}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{section.description}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {section.tools.map((tool) => (
                      <ToolLink
                        key={tool.href}
                        item={tool}
                        active={isActivePath(pathname, tool.href)}
                        count={badgeValue(badgeSummary, tool.badgeKey)}
                        onClick={() => setOpenSection(null)}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
        <div className="md:hidden">
          <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
            <PopoverTrigger
              render={(props) => (
                <Button {...props} variant="ghost" size="sm" className="h-8 gap-2 px-2">
                  <Menu className="size-4" aria-hidden="true" />
                  Menu
                </Button>
              )}
            />
            <PopoverContent className="max-h-[80vh] w-[calc(100vw-2rem)] overflow-auto p-3" align="start">
              <div className="space-y-3">
                {canAccessHome && (
                  <Link
                    href={HOME_HREF}
                    onClick={() => setMobileOpen(false)}
                    className={cn(navLinkClass(pathname === HOME_HREF), "w-full justify-start")}
                  >
                    Home
                  </Link>
                )}
                {sections.map((section) => (
                  <div key={section.id} className="space-y-2">
                    <div className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {section.label}
                    </div>
                    {section.tools.map((tool) => (
                      <ToolLink
                        key={tool.href}
                        item={tool}
                        active={isActivePath(pathname, tool.href)}
                        count={badgeValue(badgeSummary, tool.badgeKey)}
                        onClick={() => setMobileOpen(false)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </nav>
  );
}
