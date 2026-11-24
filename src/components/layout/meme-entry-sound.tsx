"use client";

import { useEffect } from "react";

const storageKey = "begifted:meme-entry-sound-played";

export function MemeEntrySound() {
  useEffect(() => {
    if (sessionStorage.getItem(storageKey)) return;

    const audio = new Audio(new URL("./meme-entry.mp3", import.meta.url).href);
    const playback = new AbortController();

    async function play() {
      await audio.play();
      if (!playback.signal.aborted) sessionStorage.setItem(storageKey, "1");
    }

    void play().catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError") return;
      window.addEventListener("click", () => { void play().catch(() => {}); }, {
        capture: true,
        once: true,
        signal: playback.signal,
      });
    });

    return () => {
      playback.abort();
      audio.pause();
    };
  }, []);

  return null;
}
