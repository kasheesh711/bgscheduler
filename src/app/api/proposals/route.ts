import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import {
  createProposalBundle,
  ProposalConflictError,
  ProposalValidationError,
} from "@/lib/proposals/data";
import { weekdayForIsoDate } from "@/lib/proposals/overlap";
import type { ProposalCreateInput, ResolvedProposalCreateItem } from "@/lib/proposals/types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const proposalItemSchema = z.object({
  tutorGroupId: z.string().min(1),
  scope: z.enum(["recurring", "one_time"]),
  weekday: z.number().int().min(0).max(6).optional(),
  date: z.string().regex(ISO_DATE_RE).optional(),
  startMinute: z.number().int().min(0).max(24 * 60),
  endMinute: z.number().int().min(1).max(24 * 60),
  subject: z.string().optional(),
  curriculum: z.string().optional(),
  level: z.string().optional(),
});

const proposalCreateSchema = z.object({
  studentLabel: z.string().trim().min(1),
  notes: z.string().optional(),
  items: z.array(proposalItemSchema).min(1),
});

function isDatabaseOverlapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("proposal_items_no_recurring_overlap") ||
    message.includes("proposal_items_no_one_time_overlap");
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = proposalCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();

  try {
    const index = await ensureIndex(db);
    const groupById = new Map(index.tutorGroups.map((group) => [group.id, group]));

    const items: ResolvedProposalCreateItem[] = parsed.data.items.map((item) => {
      const group = groupById.get(item.tutorGroupId);
      if (!group) {
        throw new ProposalValidationError(`Tutor not found in active snapshot: ${item.tutorGroupId}`);
      }

      const weekday = item.scope === "one_time"
        ? weekdayForIsoDate(item.date ?? "")
        : item.weekday;

      if (weekday === undefined || Number.isNaN(weekday)) {
        throw new ProposalValidationError("Proposal item needs a valid day/date");
      }

      return {
        ...item,
        weekday,
        tutorGroupId: group.id,
        tutorCanonicalKey: group.canonicalKey,
        tutorDisplayName: group.displayName,
      };
    });

    const input: ProposalCreateInput = {
      studentLabel: parsed.data.studentLabel,
      notes: parsed.data.notes,
      items,
    };

    const created = await createProposalBundle(db, input, {
      email: session.user?.email,
      name: session.user?.name,
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof ProposalConflictError) {
      return NextResponse.json(
        { error: "Proposal conflicts with an active hold", conflict: error.conflict },
        { status: 409 },
      );
    }
    if (error instanceof ProposalValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (isDatabaseOverlapError(error)) {
      return NextResponse.json(
        { error: "Proposal conflicts with an active hold" },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to create proposal";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
