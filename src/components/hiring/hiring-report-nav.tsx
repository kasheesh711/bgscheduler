"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";
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
const JUMP_KEY = "hiringReportJump";
type JumpBookmark = { href: string; fragment: string; top: number };
const currentHref = () => window.location.pathname + window.location.search + window.location.hash;
type ScrollTrip = {
  positions: Record<string, number>;
  pending: string | null;
  origin?: { key: string; href: string };
};

function hiringScrollTrip(): ScrollTrip {
  const saved = sessionStorage.getItem(SCROLL_KEY);
  return saved ? JSON.parse(saved) : { positions: {}, pending: null };
}

function hiringOrigin(key: string, trip: ScrollTrip) {
  if (trip.origin?.key !== key) return null;
  const url = new URL(trip.origin.href, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== "/hiring") return null;
  return url.pathname + url.search + url.hash;
}

// Each page scrolls within its own panel.
export function saveHiringScroll(key: string, pane: HTMLElement | null, next?: string) {
  if (!pane) return;
  try {
    const trip: ScrollTrip = next ? hiringScrollTrip() : {
      positions: {},
      pending: null,
      origin: { key, href: currentHref() },
    };
    trip.positions[key] = Math.max(0, pane.scrollTop);
    trip.pending = next ?? null;
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(trip));
  } catch {
    // Browser storage can be unavailable.
  }
}

function revealFragment(pane: HTMLElement, hash: string, center = false) {
  const target = pane.querySelector<HTMLElement>(`#${CSS.escape(hash.slice(1))}`);
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(pane).scrollPaddingTop) || 0;
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const offset = center ? (pane.clientHeight - rect.height) / 2 : padding + margin;
  pane.scrollTop += rect.top - pane.getBoundingClientRect().top - offset;
  target.focus({ preventScroll: true });
  return true;
}

export function restoreHiringScroll(key: string, pane: HTMLElement | null, fragment?: string, followFragment = false) {
  if (!pane) return;
  const hash = fragment ? `#${fragment}` : null;
  const openFragment = followFragment || window.location.hash === hash;
  let top = Number.NaN;
  let workspaceOrigin: string | null = null;
  try {
    const trip = hiringScrollTrip();
    if (trip.pending === key) {
      top = trip.positions[key];
      workspaceOrigin = hiringOrigin(key, trip);
    }
  } catch {
    // A shared hash link can still open without browser storage.
  }
  if (!openFragment && !Number.isFinite(top)) return;
  const pathname = key.startsWith("/") ? key.split("?")[0] : "/hiring";
  const workspaceUrl = workspaceOrigin && new URL(workspaceOrigin, window.location.origin);
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
      if (trip.origin?.key === key) delete trip.origin;
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
      if (workspaceUrl && workspaceUrl.search === window.location.search && currentHref() !== workspaceOrigin) {
        const oldURL = window.location.href;
        window.history.replaceState(window.history.state, "", workspaceOrigin);
        window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
      }
      if (openFragment) {
        // A report can show its navigation before its contents arrive.
        if (hash && window.location.hash === hash && revealFragment(pane, hash)) {
          if (window.scrollY) window.scrollTo(0, 0);
          if (++restoredFrames === 3) return finish();
        }
        if (window.location.hash !== hash && !followFragment) return finish();
      } else if (window.location.hash && workspaceOrigin !== currentHref()) {
        return finish();
      } else if (window.location.hash && top === 0) {
        revealFragment(pane, window.location.hash, true);
        return finish();
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

export function HiringReportJump({ fragment, children, className }: { fragment: string; children: ReactNode; className?: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  return <Link ref={link} className={className} href={`#${fragment}`} prefetch={false} scroll={false} onNavigate={() => {
    const pane = link.current?.closest("section");
    if (!pane) return;
    const bookmark: JumpBookmark = { href: currentHref(), fragment, top: pane.scrollTop };
    window.history.replaceState({ ...window.history.state, [JUMP_KEY]: bookmark }, "");
    restoreHiringScroll(window.location.pathname + window.location.search, pane, fragment, true);
  }}>{children}</Link>;
}

export function HiringReportNav({ active, fragments }: { active: Report; fragments: readonly string[] }) {
  const router = useRouter();
  const origin = useSearchParams().get("from");
  const view = origin && Object.hasOwn(HIRING_VIEWS, origin) ? origin as keyof typeof HIRING_VIEWS : null;
  const from = view ?? (origin === "dashboard" ? origin : null);
  const back = view ? `/hiring?view=${view}` : from ? "/hiring" : "/hiring?view=overview";
  const backLabel = view ? HIRING_VIEWS[view] : from ? HIRING_VIEWS.overview : "Hiring";
  const navRef = useRef<HTMLElement>(null);
  const key = hiringReportHref(active, from);
  const workspaceKey = `workspace:${from ?? "overview"}`;
  const rememberPlace = (next: string) => saveHiringScroll(key, navRef.current?.closest("section") ?? null, next);
  useLayoutEffect(() => {
    const pane = navRef.current?.closest("section") ?? null;
    let frame = 0;
    let stop: (() => void) | undefined;
    const restore = () => {
      stop?.();
      const bookmark: JumpBookmark | undefined = window.history.state?.[JUMP_KEY];
      if (pane?.clientHeight && bookmark?.href === currentHref() && fragments.includes(bookmark.fragment)) {
        pane.scrollTop = bookmark.top;
        pane.querySelector<HTMLAnchorElement>(`a[href="#${bookmark.fragment}"]`)?.focus({ preventScroll: true });
        return;
      }
      const fragment = fragments.find(id => window.location.hash === `#${id}`);
      stop = restoreHiringScroll(key, pane, fragment);
    };
    restore();
    const onPop = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [key, fragments]);
  return (
    <nav ref={navRef} className={nav.reportNav} aria-label="Hiring reports">
      <Link href={back} prefetch={false} scroll={false} className={nav.reportBack} aria-label={backLabel === "Hiring" ? "Back to Hiring" : `Back to ${backLabel} in Hiring`} onNavigate={(event) => {
        rememberPlace(workspaceKey);
        try {
          const href = from && hiringOrigin(workspaceKey, hiringScrollTrip());
          if (href && href !== back) {
            event.preventDefault();
            router.push(href.split("#")[0], { scroll: false });
          }
        } catch {
          // The link can still return to the named workspace.
        }
      }}>
        <span aria-hidden="true">←</span>
        <span className={nav.backFull}>Back to {backLabel}</span>
        <span className={nav.backShort}>Hiring</span>
      </Link>
      {(Object.keys(HIRING_REPORTS) as Report[]).map((report) => {
        if (report === active) return <span key={report} aria-current="page">{HIRING_REPORTS[report]}</span>;
        const href = hiringReportHref(report, from);
        return <Link key={report} href={href} prefetch={false} scroll={false} onNavigate={() => rememberPlace(href)}>{HIRING_REPORTS[report]}</Link>;
      })}
    </nav>
  );
}
