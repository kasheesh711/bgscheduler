import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ManageAccess } from "@/components/admin-users/manage-access";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { listAdminUsers } from "@/lib/admin-users/data";
import { AdminUsersAccessError } from "@/lib/admin-users/types";

async function ManageAccessBody() {
  try {
    await requireSuperAdmin();
  } catch (error) {
    if (error instanceof AdminUsersAccessError) redirect(error.status === 401 ? "/login" : "/");
    throw error;
  }
  return <ManageAccess initialRows={await listAdminUsers()} />;
}

export const metadata: Metadata = { title: "Manage Access | BeGifted Ops", robots: { index: false, follow: false } };

export default function ManageAccessPage() {
  return <Suspense fallback={<p className="text-sm text-muted-foreground">Loading website accounts…</p>}><ManageAccessBody /></Suspense>;
}
