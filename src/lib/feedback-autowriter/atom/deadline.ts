import { AtomCollectionError } from "./normalize";

/**
 * Resolve with `promise`, or throw a `collection_failed` labelled with `stage` once `ms` has passed. The pending work
 * is not cancelled; callers must not rely on it finishing. Used wherever Playwright or the run itself could otherwise
 * wait past Vercel's function limit, where the run would be killed before recording why it stopped.
 */
export async function withAtomTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AtomCollectionError("collection_failed", stage)), Math.max(0, ms));
    })]);
  } finally {
    clearTimeout(timer);
  }
}
