import type { Metadata } from "next";
import Link from "next/link";
import { HiringStaffPreview } from "@/components/hiring/staff-preview";
import { resolveUserAccess } from "@/lib/auth-access";
import { navigationAccess } from "@/lib/navigation/tools";
import { isRoleView } from "@/lib/hiring/role-views";
import { canUseClassCapture } from "@/lib/class-capture/sessions";
import { creditControlActive } from "@/lib/credit-control/mode";
import { resolveLearningPlansAccess } from "@/lib/learning-plans/access";
import { getPostClassCapabilities } from "@/lib/post-class-feedback/access";
import { canUseAttendance } from "@/lib/tutor-attendance/access";
import { canUseSitIns } from "@/lib/tutor-sit-ins/access";
import { getUnearnedRevenueCapabilities } from "@/lib/unearned-revenue/access";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ManageAccess } from "@/components/admin-users/manage-access";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { listAdminUsers } from "@/lib/admin-users/data";
import { AdminUsersAccessError } from "@/lib/admin-users/types";

type Search = Promise<{ preview?: string; hiringView?: string }>;
const hiringViews = [["hr", "HR"], ["admin", "Admin"], ["heads", "Department heads"]] as const;

async function ManageAccessBody({ searchParams }: { searchParams: Search }) {
  try {
    await requireSuperAdmin();
  } catch (error) {
    if (error instanceof AdminUsersAccessError) redirect(error.status === 401 ? "/login" : "/");
    throw error;
  }
  const [{ preview, hiringView }, rows] = await Promise.all([searchParams, listAdminUsers()]);
  if (typeof preview !== "string") return <ManageAccess initialRows={rows} />;
  const email = preview.trim().toLowerCase();
  const target = rows.find((row) => row.email.trim().toLowerCase() === email);
  const access = email.length <= 254 && email.includes("@") && !target?.isOwner && !target?.disabled
    ? await resolveUserAccess(email)
    : null;
  if (!access || access.role === "student" || access.role === "parent") {
    return <div className="space-y-3"><p role="status">This staff account is unavailable for preview.</p><Link href="/admin/users" className="underline">Exit preview</Link></div>;
  }

  const [feedback, unearned, learningPlansAccess, attendanceAccess, sitInAccess, classCaptureAccess] = await Promise.all([
    getPostClassCapabilities(email),
    getUnearnedRevenueCapabilities(email),
    resolveLearningPlansAccess({ email, ...access }),
    canUseAttendance(email),
    canUseSitIns(email),
    canUseClassCapture({ email, ...access }),
  ]);
  const { sections } = navigationAccess(access.allowedPages, {
    postClassFeedbackAccess: feedback.includes("viewer"), unearnedRevenueAccess: unearned.includes("viewer"),
    learningPlansAccess, attendanceAccess, sitInAccess, classCaptureAccess, creditControlEnabled: creditControlActive(),
  });
  const landing = access.allowedPages?.length === 1 ? access.allowedPages[0] : "/";
  const canViewHiring = access.role === "admin" && (!access.allowedPages || access.allowedPages.includes("/hiring"));
  const previewHref = `/admin/users?preview=${encodeURIComponent(email)}`;
  const role = canViewHiring && isRoleView(hiringView) ? hiringView : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-6">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3">
        <h1 className="text-lg font-semibold">Viewing as {target?.name || email}</h1>
        <Link className="text-sm underline" href="/admin/users">Exit preview</Link>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="staff-preview">Staff account</label>
        <form action="/admin/users" method="get" className="flex items-center gap-2">
          <select id="staff-preview" name="preview" defaultValue={email} key={email} className="rounded-md border bg-background p-2">
            {!target && <option value={email}>{email}</option>}
            {rows.filter((row) => !row.disabled && !row.isOwner).map((row) => <option key={row.email} value={row.email.trim().toLowerCase()}>{row.name || row.email}</option>)}
          </select>
          <button type="submit" className="rounded-md border px-3 py-2">Switch</button>
        </form>
        <span>Read-only preview</span>
      </div>
      <p className="text-sm">Landing page: {landing === "/" ? "Home" : sections.flatMap((section) => section.tools).find((tool) => tool.href === landing)?.label ?? landing}</p>
      <details open={!role} className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Website navigation</summary>
        <div className="mt-3 flex flex-wrap gap-6">
          {sections.map((section) => (
            <section key={section.id}>
              <h2 className="text-sm font-medium">{section.label}</h2>
              <ul className="mt-1 text-sm text-muted-foreground">{section.tools.map((tool) => <li key={tool.id}>{tool.label}</li>)}</ul>
            </section>
          ))}
          {!sections.length && <p className="text-sm text-muted-foreground">This account has no tools in the navigation.</p>}
        </div>
      </details>
      {canViewHiring && (
        <nav aria-label="Hiring role previews" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Hiring preview</span>
          {hiringViews.map(([view, label]) => <Link key={view} aria-current={role === view ? "page" : undefined}
            className={`rounded-md border px-3 py-1.5 ${role === view ? "bg-primary text-primary-foreground" : ""}`}
            href={`${previewHref}&hiringView=${view}`}>{label}</Link>)}
        </nav>
      )}
      {role && <HiringStaffPreview role={role} key={`${email}:${role}`} />}
    </div>
  );
}

export const metadata: Metadata = { title: "Manage Access | BeGifted Ops", robots: { index: false, follow: false } };

export default function ManageAccessPage({ searchParams }: { searchParams: Search }) {
  return <Suspense fallback={<p className="text-sm text-muted-foreground">Loading website accounts…</p>}><ManageAccessBody searchParams={searchParams} /></Suspense>;
}
