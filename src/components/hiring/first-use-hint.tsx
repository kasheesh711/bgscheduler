"use client";

import { useState, type ReactNode } from "react";
import css from "./dashboard.module.css";

const key = (id: string) => `hiring-hint:${id}`;

/** True when this browser has dismissed the hint. Storage can throw (private window, blocked site data): then false. */
export function hintDismissed(id: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key(id)) === "1";
  } catch {
    return false;
  }
}

/** Remembers the dismissal. A storage error only means the hint shows again next time. */
export function dismissHint(id: string): void {
  try {
    globalThis.localStorage?.setItem(key(id), "1");
  } catch {
    // Nothing to do: the hint hides for this view anyway.
  }
}

/** A short first-use note at the top of a role's main view, with a "Got it" button. */
export function FirstUseHint({ id, children }: { id: string; children: ReactNode }) {
  const [hidden, setHidden] = useState(() => hintDismissed(id));
  if (hidden) return null;
  return (
    <div role="note" className={css.firstUseHint}>
      <p>{children}</p>
      <button
        type="button"
        className={css.secondary}
        onClick={() => {
          dismissHint(id);
          setHidden(true);
        }}
      >
        Got it
      </button>
    </div>
  );
}
