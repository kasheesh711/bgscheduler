"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, X } from "lucide-react";
import {
  STALE_BANNER_LINK_LABEL,
  STALE_BANNER_SESSION_KEY,
  STALE_BANNER_TEXT,
  shouldShowStaleBanner,
} from "@/lib/ops/stale";

interface DataHealthStatus {
  staleAgeMs: number | null;
}

function isWorkspacePath(pathname: string | null): boolean {
  const path = pathname ?? "";
  return (
    path === "/search" ||
    path.startsWith("/search/") ||
    path === "/compare" ||
    path.startsWith("/compare/")
  );
}

export function StaleSnapshotBanner() {
  const pathname = usePathname();
  const isWorkspace = isWorkspacePath(pathname);
  const [showBanner, setShowBanner] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isWorkspace) {
      setShowBanner(false);
      return;
    }

    try {
      if (sessionStorage.getItem(STALE_BANNER_SESSION_KEY) === "true") {
        setDismissed(true);
        setShowBanner(false);
        return;
      }
    } catch {
      // Session storage may be unavailable; keep the warning non-blocking.
    }

    setDismissed(false);

    let ignore = false;
    const controller = new AbortController();

    fetch("/api/data-health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) return null;
        return response.json() as Promise<DataHealthStatus>;
      })
      .then((data) => {
        if (ignore || data === null) return;
        const staleAgeMs = typeof data.staleAgeMs === "number" ? data.staleAgeMs : null;
        setShowBanner(shouldShowStaleBanner(staleAgeMs));
      })
      .catch(() => {
        if (!ignore) setShowBanner(false);
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [isWorkspace]);

  if (!isWorkspace || dismissed || !showBanner) {
    return null;
  }

  function dismiss() {
    try {
      sessionStorage.setItem(STALE_BANNER_SESSION_KEY, "true");
    } catch {
      // Visibility is still dismissed for the current render tree.
    }
    setDismissed(true);
    setShowBanner(false);
  }

  return (
    <div
      role="status"
      aria-label="Tutor data may be outdated. Last successful sync was over 48 hours ago."
      className="flex flex-shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100 lg:px-6"
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        {STALE_BANNER_TEXT}{" "}
        <Link
          href="/data-health"
          title="View data health"
          className="font-medium text-amber-950 underline underline-offset-2 hover:text-amber-800 dark:text-amber-100 dark:hover:text-amber-50"
        >
          {STALE_BANNER_LINK_LABEL}
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss stale data warning"
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-amber-950 transition-colors hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/40"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
