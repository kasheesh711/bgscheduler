import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissHint, FirstUseHint, hintDismissed } from "../first-use-hint";

const render = () => renderToStaticMarkup(<FirstUseHint id="hr-calls">Call the first row.</FirstUseHint>);
const memoryStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

afterEach(() => vi.unstubAllGlobals());

describe("FirstUseHint", () => {
  it("shows the note and a Got it button until dismissed", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const html = render();
    expect(html).toContain('role="note"');
    expect(html).toContain("Call the first row.");
    expect(html).toContain(">Got it</button>");
  });

  it("stays hidden after a dismissal, per hint id", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    dismissHint("hr-calls");
    expect(hintDismissed("hr-calls")).toBe(true);
    expect(hintDismissed("kevin-funnel")).toBe(false);
    expect(render()).toBe("");
  });

  it("still renders when storage throws, and dismissing does not throw", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    expect(hintDismissed("hr-calls")).toBe(false);
    expect(() => dismissHint("hr-calls")).not.toThrow();
    expect(render()).toContain("Got it");
  });
});
