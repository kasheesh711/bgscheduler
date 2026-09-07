"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AdminUserAccessRow } from "@/lib/admin-users/types";

export function ManageAccess({ initialRows }: { initialRows: AdminUserAccessRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadRows() {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load website access.");
    setRows(payload.rows);
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      await loadRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load website access.");
    } finally {
      setRefreshing(false);
    }
  }

  async function changeAccess(row: AdminUserAccessRow) {
    setPendingEmail(row.email);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: row.email, disabled: !row.disabled, expectedVersion: row.accessVersion }),
      });
      const payload = await response.json();
      if (response.status === 409) {
        await loadRows();
        setError("Someone changed access while this list was open. The list is refreshed; review it before trying again.");
        return;
      }
      if (!response.ok) throw new Error(payload.error || "Could not update website access.");
      setRows((current) => current.map((item) => item.email === row.email ? payload.row : item));
      setMessage(payload.row.disabled ? `Website access disabled for ${row.email}.` : `Website access enabled for ${row.email}. A fresh sign-in is required.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update website access.");
    } finally {
      setPendingEmail(null);
    }
  }

  return (
    <div className="w-full max-w-5xl space-y-5 overflow-auto pb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Manage Access</h1>
          <p className="mt-2 text-sm text-muted-foreground">Control who can sign in to BeGifted Ops. Disabling an account stops its existing sessions on the next request. Enabling it requires a fresh sign-in.</p>
        </div>
        <Button variant="outline" disabled={refreshing || pendingEmail !== null} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh"}</Button>
      </div>
      <p className="text-sm text-muted-foreground">GitHub publishing and protected preview sharing are managed separately in GitHub and Vercel.</p>
      {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {message && <p role="status" className="text-sm text-primary">{message}</p>}
      <Card>
        <CardHeader><CardTitle>Website accounts</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Access</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.email}>
                  <TableCell><div className="font-medium">{row.name || row.email}</div>{row.name && <div className="text-xs text-muted-foreground">{row.email}</div>}</TableCell>
                  <TableCell><Badge variant={row.disabled ? "outline" : "secondary"}>{row.disabled ? "Disabled" : "Enabled"}</Badge></TableCell>
                  <TableCell className="text-right">
                    {row.isOwner ? <span className="text-sm font-medium">Website owner</span> : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pendingEmail !== null || refreshing}
                        aria-label={`${row.disabled ? "Enable" : "Disable"} access for ${row.email}`}
                        onClick={() => changeAccess(row)}
                      >{pendingEmail === row.email ? "Saving…" : row.disabled ? "Enable access" : "Disable access"}</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
