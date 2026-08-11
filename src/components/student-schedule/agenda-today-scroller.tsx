"use client";

import { useEffect } from "react";

/**
 * Scrolls the public agenda to today (or the next upcoming day) once after
 * hydration — scrollIntoView targets the nearest scrollable ancestor, which is
 * the page's own scroll region. Instant rather than smooth: a page must not
 * animate on open. Renders nothing; when the month holds no such day the
 * effect is a no-op, and with JS disabled the page is simply read from the
 * top. The target's scroll-mt keeps its heading clear of the sticky header.
 */
export function AgendaTodayScroller() {
  useEffect(() => {
    document
      .getElementById("agenda-scroll-target")
      ?.scrollIntoView({ block: "start" });
  }, []);
  return null;
}
