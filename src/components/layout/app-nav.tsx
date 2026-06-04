"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const SCHEDULING_ITEMS = [
  { href: "/scheduler", label: "Scheduler" },
  { href: "/line-review", label: "LINE AI Review" },
  { href: "/scheduler/metrics", label: "Scheduler Metrics" },
  { href: "/search", label: "Search" },
  { href: "/leave-requests", label: "Leave Requests", badgeKey: "leaveRequests" },
  { href: "/tutor-profiles", label: "Tutor Profiles" },
  { href: "/class-assignments", label: "Class Assignments" },
  { href: "/room-capacity", label: "Room Capacity" },
];

const NAV_ITEMS = [
  { href: "/student-promotions", label: "Student Promotions" },
  { href: "/sales-dashboard", label: "Sales Dashboard" },
  { href: "/credit-control", label: "Credit Control" },
  { href: "/payroll", label: "Payroll" },
  { href: "/wise-activity", label: "Wise Audit" },
  { href: "/data-health", label: "Data Health" },
];

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function navLinkClass(isActive: boolean) {
  return cn(
    "px-3 py-1.5 text-sm rounded-md transition-colors",
    isActive
      ? "text-primary font-medium bg-primary/10"
      : "text-muted-foreground hover:text-foreground hover:bg-muted",
  );
}

export function AppNav() {
  const pathname = usePathname();
  const [schedulingOpen, setSchedulingOpen] = useState(false);
  const [leaveRequestCount, setLeaveRequestCount] = useState(0);
  const schedulingActive = SCHEDULING_ITEMS.some((item) => isActivePath(pathname, item.href));

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/leave-requests?summaryOnly=true", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { unreadActionCount?: number } | null) => {
        setLeaveRequestCount(Number(payload?.unreadActionCount ?? 0));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [pathname]);

  return (
    <nav className="flex h-11 flex-shrink-0 items-center overflow-x-auto border-b border-border bg-card px-4 [scrollbar-width:none] lg:px-6 [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max items-center gap-6">
        <Link href="/search" className="text-sm font-semibold text-primary tracking-tight">
          BeGifted Ops
        </Link>
        <div className="flex items-center gap-1">
          <Popover open={schedulingOpen} onOpenChange={setSchedulingOpen}>
            <PopoverTrigger
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-auto gap-1.5 px-3 py-1.5 rounded-md",
                    schedulingActive
                      ? "text-primary font-medium bg-primary/10 hover:bg-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  Scheduling Tools
                  <ChevronDown
                    aria-hidden="true"
                    className={cn("size-3.5 transition-transform", schedulingOpen && "rotate-180")}
                  />
                </Button>
              )}
            />
            <PopoverContent className="w-56 gap-1 p-1.5" align="start">
              {SCHEDULING_ITEMS.map((item) => {
                const isActive = isActivePath(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSchedulingOpen(false)}
                    className={cn(navLinkClass(isActive), "flex items-center justify-between gap-2")}
                  >
                    <span>{item.label}</span>
                    {item.badgeKey === "leaveRequests" && leaveRequestCount > 0 && (
                      <Badge variant="outline" className="border-amber-200 bg-amber-50 px-1.5 text-amber-900">
                        {leaveRequestCount}
                      </Badge>
                    )}
                  </Link>
                );
              })}
            </PopoverContent>
          </Popover>
          {NAV_ITEMS.map((item) => {
            const isActive = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={navLinkClass(isActive)}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
