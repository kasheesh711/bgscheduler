import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render, children }: { render?: (props: Record<string, unknown>) => React.ReactNode; children?: React.ReactNode }) => (
    <>{render ? render({}) : children}</>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { usePathname } from "next/navigation";
import { AppNav } from "@/components/layout/app-nav";

describe("AppNav", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/");
  });

  it("renders Home and four business-function menus for full admins", () => {
    const html = renderToStaticMarkup(<AppNav allowedPages={null} />);

    expect(html).toContain("BeGifted Ops");
    expect(html).toContain("Home");
    expect(html).toContain("Scheduling &amp; Tutors");
    expect(html).toContain("Student Lifecycle");
    expect(html).toContain("Finance &amp; Revenue");
    expect(html).toContain("Data &amp; Audit");
    expect(html).toContain("tutor time-off requests");
    expect(html).toContain("prepaid-credit follow-up");
  });

  it("filters menu content for single-page restricted users", () => {
    vi.mocked(usePathname).mockReturnValue("/progress-tests");

    const html = renderToStaticMarkup(<AppNav allowedPages={["/progress-tests"]} />);

    expect(html).toContain("Progress Tests");
    expect(html).not.toContain(">Home<");
    expect(html).not.toContain("Credit Control");
    expect(html).not.toContain("Leave Requests");
  });

  it("marks the current section active", () => {
    vi.mocked(usePathname).mockReturnValue("/payroll");

    const html = renderToStaticMarkup(<AppNav allowedPages={null} />);

    expect(html).toContain("bg-primary/10 font-medium text-primary");
    expect(html).toContain("Payroll");
  });
});
