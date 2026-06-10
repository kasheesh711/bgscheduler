"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SalesDimensionsPayload } from "@/lib/sales-dashboard/types";

// ----------------------------------------------------------------------------
// Lazy client cache for /api/sales-dashboard/dimensions. Fetched once on the
// first non-Overview tab activation; invalidated by the shell after imports
// or source mutations via invalidateSalesDimensions().
// ----------------------------------------------------------------------------

interface SalesDimensionsState {
  dimensions: SalesDimensionsPayload | null;
  loading: boolean;
  error: string;
}

let cachedPayload: SalesDimensionsPayload | null = null;
let cacheVersion = 0;
const listeners = new Set<() => void>();

/**
 * Drop the client-side dimensions cache and notify mounted hooks. Call after
 * any action that changes the underlying sales rows (imports, source edits).
 * Refetch happens lazily — only while a non-Overview tab needs the data.
 */
export function invalidateSalesDimensions(): void {
  cachedPayload = null;
  cacheVersion += 1;
  for (const listener of listeners) listener();
}

/**
 * Subscribe to sales-data invalidations (useSyncExternalStore contract).
 * Components that keep their own per-mount caches over the same sales rows
 * (e.g. TransactionsTable) use this to drop them when an import lands.
 */
export function subscribeSalesDimensionsVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current invalidation counter — bumps on every invalidateSalesDimensions(). */
export function getSalesDimensionsVersion(): number {
  return cacheVersion;
}

export function useSalesDimensions({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<SalesDimensionsState>({
    dimensions: cachedPayload,
    loading: false,
    error: "",
  });
  const [version, setVersion] = useState(cacheVersion);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const listener = () => setVersion(cacheVersion);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Adopt a warm module cache during render (filled by another hook instance).
  if (enabled && cachedPayload && state.dimensions !== cachedPayload) {
    setState({ dimensions: cachedPayload, loading: false, error: "" });
  }

  useEffect(() => {
    if (!enabled || cachedPayload) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // Keep stale dimensions visible while revalidating.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-start flag for the lazy dimensions load
    setState((previous) => ({ ...previous, loading: true, error: "" }));

    fetch("/api/sales-dashboard/dimensions", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error((body as { error?: string }).error || `Dimensions request failed (${response.status})`);
        }
        return body as SalesDimensionsPayload;
      })
      .then((payload) => {
        cachedPayload = payload;
        setState({ dimensions: payload, loading: false, error: "" });
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: fetchError instanceof Error ? fetchError.message : "Failed to load sales dimensions",
        }));
      });

    return () => controller.abort();
  }, [enabled, version]);

  const invalidate = useCallback(() => invalidateSalesDimensions(), []);

  return { ...state, invalidate };
}
