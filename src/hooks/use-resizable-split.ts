import { useCallback, useRef, useState } from "react";

const STORAGE_KEY = "begifted-split-ratio";
const DEFAULT_RATIO = 0.6;
const MIN_RATIO = 0.3;
const MAX_RATIO = 0.8;

export function useResizableSplit() {
  const [ratio, setRatio] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_RATIO;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = parseFloat(stored);
      if (!isNaN(parsed) && parsed >= MIN_RATIO && parsed <= MAX_RATIO) return parsed;
    }
    return DEFAULT_RATIO;
  });

  const containerRef = useRef<HTMLElement>(null);
  const dragging = useRef(false);

  const persist = useCallback((value: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch { /* quota */ }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    dragging.current = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const newRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, x / rect.width));
    setRatio(newRatio);
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setRatio((current) => {
      persist(current);
      return current;
    });
  }, [persist]);

  return {
    ratio,
    containerRef,
    dividerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}
