"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/search", label: "Search" },
  { href: "/data-health", label: "Data Health" },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center justify-between border-b border-border bg-card px-4 lg:px-6 h-11 flex-shrink-0">
      <div className="flex items-center gap-6">
        <Link href="/search" className="text-sm font-semibold text-primary tracking-tight">
          BeGifted Tutor Search
        </Link>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  isActive
                    ? "text-primary font-medium bg-primary/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
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
