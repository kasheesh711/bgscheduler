import type { WiseTeacher } from "@/lib/wise/types";

export type RemovalMode = "manual" | "live";
export type RemovalRunStatus = "previewed" | "applying" | "applied" | "applied_with_errors" | "expired";
export type RemovalAccountStatus = "planned" | "skipped" | "sending" | "sent" | "rejected" | "unknown" | "verified" | "not_removed" | "manual_required" | "removed_manually" | "restored";
export interface RemovalLocalState { contactActive: boolean | null; profileActive: boolean | null }
export interface RemovalAccount {
  id: string; runId: string; canonicalKey: string; displayName: string;
  wiseTeacherId: string; wiseUserId: string | null; isOnlineVariant: boolean;
  accountSnapshot: WiseTeacher; likelihoodAtPreview: number; reasons: string[];
  plan: "remove" | "skip"; skipReason: string | null; status: RemovalAccountStatus;
  errorMessage: string | null; sentAt: string | null; verifiedAt: string | null;
  localStateBefore: RemovalLocalState | null;
}
export interface RemovalRun {
  id: string; status: RemovalRunStatus; mode: RemovalMode; reason: string | null;
  previewToken: string; previewExpiresAt: string; tutorCount: number; accountCount: number;
  createdByEmail: string; createdAt: string; appliedByEmail: string | null;
  appliedAt: string | null; finishedAt: string | null;
}
export interface RemovalRunDetail extends RemovalRun { accounts: RemovalAccount[] }
export interface RemovalApplyInput { previewToken: string; confirmed: true; reason: string; accountCount: number }
