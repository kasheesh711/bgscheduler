export type ProposalScope = "recurring" | "one_time";

export type ProposalStatus =
  | "pending"
  | "confirmed"
  | "released"
  | "expired"
  | "auto_resolved";

export type ActiveProposalStatus = Extract<ProposalStatus, "pending" | "confirmed">;

export interface ProposalHoldSummary {
  itemId: string;
  bundleId: string;
  studentLabel: string;
  notes?: string;
  tutorGroupId?: string;
  tutorCanonicalKey: string;
  tutorDisplayName: string;
  scope: ProposalScope;
  weekday: number;
  date?: string;
  startMinute: number;
  endMinute: number;
  startTime: string;
  endTime: string;
  subject?: string;
  curriculum?: string;
  level?: string;
  status: ActiveProposalStatus;
  createdByEmail?: string;
  createdByName?: string;
  createdAt: string;
  expiresAt?: string;
  confirmedAt?: string;
}

export interface ProposalCreateItemInput {
  tutorGroupId: string;
  scope: ProposalScope;
  weekday?: number;
  date?: string;
  startMinute: number;
  endMinute: number;
  subject?: string;
  curriculum?: string;
  level?: string;
}

export interface ResolvedProposalCreateItem extends Omit<ProposalCreateItemInput, "weekday"> {
  tutorGroupId: string;
  tutorCanonicalKey: string;
  tutorDisplayName: string;
  weekday: number;
}

export interface ProposalCreateInput {
  studentLabel: string;
  notes?: string;
  items: ResolvedProposalCreateItem[];
}

export interface ProposalActor {
  email?: string | null;
  name?: string | null;
}

export type ProposalPatchAction = "confirm" | "release" | "extend";
