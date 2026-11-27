import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));
vi.mock("next-auth/react", () => ({ signIn: () => {} }));
import { HiringDashboard } from "../dashboard";

// The first render, before the hiring data loads: a head opens on their own list.
const html = (props: Parameters<typeof HiringDashboard>[0]) => renderToStaticMarkup(<HiringDashboard {...props} />);

describe("HiringDashboard for a signed-in head", () => {
  it("hides the way to the full dashboard from a head with a page limit (Kevin, 24 Nov 2026)", () => {
    const page = html({ head: "Ek" });
    expect(page).toContain("My list");
    expect(page).not.toContain("Full dashboard");
  });

  it("keeps the way to the full dashboard for a head with no page limit (Kevin, 25 Nov 2026)", () => {
    const page = html({ head: "Kevin", fullAccess: true });
    expect(page).toContain("My list");
    expect(page).toContain("Full dashboard");
  });

  it("shows staff who are not heads the full dashboard", () => {
    const page = html({});
    expect(page).not.toContain("My list");
    expect(page).toContain("Hiring tools");
  });
});
