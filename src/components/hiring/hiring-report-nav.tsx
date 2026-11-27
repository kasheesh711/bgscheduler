"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import nav from "./pipeline-nav.module.css";

export const HIRING_VIEWS = {
  overview: "Overview",
  capacity: "Capacity",
  seek: "SEEK intake",
  calls: "HR calls",
  prescreen: "Pre-screen form",
  visitday: "Visit schedule",
  assessment: "Paper test",
  mock: "Mock teaching",
  review: "Final review",
  offer: "Offer & signing",
  setup: "Rules and setup",
  // Each role screen has its own link.
  hr: "Final review",
  admin: "Admin",
  heads: "Heads",
};

export const HIRING_REPORTS = {
  "paper-results": "Paper analytics",
  "ats-outcomes": "ATS outcomes",
} as const;

type Report = keyof typeof HIRING_REPORTS;

export function hiringReportHref(report: Report, from: string | null) {
  return `/hiring/${report}${from ? `?from=${from}` : ""}`;
}

const SCROLL_KEY = "hiring-report-scroll";
type ScrollTrip = { positions: Record<string, number>; pending: string | null };

function hiringScrollTrip(): ScrollTrip {
  const saved = sessionStorage.getItem(SCROLL_KEY);
  return saved ? JSON.parse(saved) : { positions: {}, pending: null };
}

// Each page scrolls within its own panel.
export function saveHiringScroll(key: string, pane: HTMLElement | null, next?: string) {
  if (!pane) return;
  try {
    const trip = next ? hiringScrollTrip() : { positions: {}, pending: null };
    trip.positions[key] = Math.max(0, pane.scrollTop);
    trip.pending = next ?? null;
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(trip));
  } catch {
    // Browser storage can be unavailable.
  }
}

export function restoreHiringScroll(key: string, pane: HTMLElement | null, fragment?: string) {
  if (!pane) return;
  const hash = fragment ? `#${fragment}` : null;
  const openFragment = window.location.hash === hash;
  let top = Number.NaN;
  try {
    const trip = hiringScrollTrip();
    if (trip.pending === key) top = trip.positions[key];
  } catch {
    // A shared hash link can still open without browser storage.
  }
  if (!openFragment && !Number.isFinite(top)) return;
  const pathname = key.startsWith("/") ? key.split("?")[0] : "/hiring";
  const deadline = performance.now() + (openFragment ? 10000 : 5000);
  const input = ["pointerdown", "wheel", "touchmove", "keydown"] as const;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const event of input) pane.removeEventListener(event, finish);
  };
  const finish = () => {
    stop();
    try {
      const trip = hiringScrollTrip();
      if (trip.pending !== key) return;
      delete trip.positions[key];
      trip.pending = null;
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(trip));
    } catch {
      // Browser storage can be unavailable.
    }
  };
  let restoredFrames = 0;
  const restore = (now: number) => {
    if (now >= deadline) return finish();
    if (window.location.pathname === pathname && pane.clientHeight) {
      // A report can show its navigation before its contents arrive.
      if (window.location.hash) {
        if (window.location.hash !== hash || pane.scrollTop > 0) return finish();
        const target = hash && pane.querySelector(hash);
        if (target) {
          target.scrollIntoView({ block: "start" });
          return finish();
        }
      } else if (pane.scrollHeight - pane.clientHeight >= top - 1) {
        if (Math.abs(pane.scrollTop - top) > 0.5) {
          pane.scrollTop = top;
          restoredFrames = 0;
        }
        if (++restoredFrames === 3) return finish();
      }
    }
    frame = requestAnimationFrame(restore);
  };
  let frame = requestAnimationFrame(restore);
  for (const event of input) pane.addEventListener(event, finish, { passive: true });
  return stop;
}

export function HiringReportNav({ active, fragment }: { active: Report; fragment: string }) {
  const origin = useSearchParams().get("from");
  const view = origin && Object.hasOwn(HIRING_VIEWS, origin) ? origin as keyof typeof HIRING_VIEWS : null;
  const from = view ?? (origin === "dashboard" ? origin : null);
  const back = view ? `/hiring?view=${view}` : from ? "/hiring" : "/hiring?view=overview";
  const backLabel = view ? HIRING_VIEWS[view] : from ? HIRING_VIEWS.overview : "Hiring";
  const navRef = useRef<HTMLElement>(null);
  const key = hiringReportHref(active, from);
  const rememberPlace = (next: string) => saveHiringScroll(key, navRef.current?.closest("section") ?? null, next);
  useLayoutEffect(() => restoreHiringScroll(key, navRef.current?.closest("section") ?? null, fragment), [key, fragment]);
  return (
    <nav ref={navRef} className={nav.reportNav} aria-label="Hiring reports">
      <Link href={back} prefetch={false} scroll={false} className={nav.reportBack} onNavigate={() => rememberPlace(`workspace:${from ?? "overview"}`)}>
        <span aria-hidden="true">←</span> Back to {backLabel}
      </Link>
      {(Object.keys(HIRING_REPORTS) as Report[]).map((report) => (
        <Link key={report} href={hiringReportHref(report, from)} prefetch={false} scroll={false} onNavigate={active === report ? undefined : () => rememberPlace(hiringReportHref(report, from))}
          aria-current={active === report ? "page" : undefined}>
          {HIRING_REPORTS[report]}
        </Link>
      ))}
    </nav>
  );
}
