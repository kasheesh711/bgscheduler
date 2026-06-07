import { revalidateTag } from "next/cache";
import {
  appendCreditFollowUpLog,
  clearCreditInactive,
  deleteCreditFollowUpState,
  markCreditInactive,
  upsertCreditFollowUpState,
} from "@/lib/credit-control/db";
import { CREDIT_CONTROL_CACHE_TAG } from "@/lib/credit-control/config";
import type { StudentActionStatus } from "@/types/credit-control";

export interface SetStudentActionInput {
  studentKey: string;
  studentName: string;
  parentName: string;
  status: StudentActionStatus;
  updatedByEmail: string;
  updatedByName: string;
}

export interface ClearStudentActionInput {
  studentKey: string;
  studentName: string;
  parentName: string;
  actorEmail: string;
  actorName: string;
}

export interface BulkSetActionInput {
  updates: Array<{
    studentKey: string;
    studentName: string;
    parentName: string;
    status: StudentActionStatus;
  }>;
  actorEmail: string;
  actorName: string;
}

export interface BulkClearActionInput {
  updates: Array<{
    studentKey: string;
    studentName: string;
    parentName: string;
  }>;
  actorEmail: string;
  actorName: string;
}

export interface MarkInactiveStudentInput {
  studentKey: string;
  studentName: string;
  parentName: string;
  markedByEmail: string;
  /** "manual" (default) or "auto-churn". */
  source?: string;
  /** Total remaining credits at removal; used for genuine-top-up reactivation. */
  removedAtRemaining?: number | null;
}

export async function setStudentAction(input: SetStudentActionInput): Promise<void> {
  await upsertCreditFollowUpState({
    studentKey: input.studentKey,
    studentName: input.studentName,
    parentName: input.parentName,
    status: input.status,
    updatedByEmail: input.updatedByEmail,
    updatedByName: input.updatedByName,
  });
  await appendCreditFollowUpLog({
    studentKey: input.studentKey,
    studentName: input.studentName,
    parentName: input.parentName,
    actionType: "set",
    status: input.status,
    actorEmail: input.updatedByEmail,
    actorName: input.updatedByName,
  });
  revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
}

export async function clearStudentAction(input: ClearStudentActionInput): Promise<void> {
  await deleteCreditFollowUpState(input.studentKey);
  await appendCreditFollowUpLog({
    studentKey: input.studentKey,
    studentName: input.studentName,
    parentName: input.parentName,
    actionType: "clear",
    status: null,
    actorEmail: input.actorEmail,
    actorName: input.actorName,
  });
  revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
}

export async function bulkSetAction(input: BulkSetActionInput): Promise<void> {
  await Promise.all(input.updates.map(async (update) => {
    await upsertCreditFollowUpState({
      studentKey: update.studentKey,
      studentName: update.studentName,
      parentName: update.parentName,
      status: update.status,
      updatedByEmail: input.actorEmail,
      updatedByName: input.actorName,
    });
    await appendCreditFollowUpLog({
      studentKey: update.studentKey,
      studentName: update.studentName,
      parentName: update.parentName,
      actionType: "bulk-set",
      status: update.status,
      actorEmail: input.actorEmail,
      actorName: input.actorName,
    });
  }));
  revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
}

export async function bulkClearAction(input: BulkClearActionInput): Promise<void> {
  await Promise.all(input.updates.map(async (update) => {
    await deleteCreditFollowUpState(update.studentKey);
    await appendCreditFollowUpLog({
      studentKey: update.studentKey,
      studentName: update.studentName,
      parentName: update.parentName,
      actionType: "bulk-clear",
      status: null,
      actorEmail: input.actorEmail,
      actorName: input.actorName,
    });
  }));
  revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
}

export async function markInactiveStudent(input: MarkInactiveStudentInput): Promise<void> {
  await markCreditInactive(input);
  revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
}

export async function clearInactiveStudent(studentKey: string): Promise<void> {
  await clearCreditInactive(studentKey);
  revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
}
