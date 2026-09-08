/** Snapshot-independent evidence used by the Leave Requests work queue. */
export interface LeaveWindow {
  startDate: string;
  endDate: string;
  startMinute: number;
  endMinute: number;
}

export interface LeaveInterpretation {
  disposition: "active" | "duplicate" | "withdrawn" | "unresolved";
  windows: LeaveWindow[];
  completion: Array<{
    dates: string[]; // Empty means every date in this submission's windows.
    parentsInformed: boolean;
    classesCancelled: boolean;
    actorLabel: string | null;
    evidence: string;
  }>;
  explanation: string;
  errors: string[];
}

export interface WorkStudent {
  studentKey: string;
  wiseStudentId: string;
  name: string;
  parentName: string | null;
  contacts: Array<{ id: string; name: string | null; url: string | null }>;
}

export interface CompletionEvidence {
  source: "admin" | "sheet" | "wise";
  actorEmail: string | null;
  actorName: string | null;
  completedAt: string | null; // Imported notes do not establish a timestamp.
  recordedAt: string;
  note: string | null;
  normalizationId?: string;
}

export interface CoverageRevision { sessionId: string; revision: string }

export interface ClassWork {
  id: string;
  assignmentId: string;
  wiseSessionId: string;
  wiseClassId: string;
  startTime: string;
  endTime: string;
  subject: string;
  title: string;
  students: WorkStudent[];
  revision: string;
  sourceRequestIds: string[];
  wiseStatus: string;
  issue: string | null;
  active: boolean;
  cancelled: CompletionEvidence | null;
  version: number;
}

export interface FamilyWork {
  id: string;
  assignmentId: string;
  familyKey: string;
  label: string;
  students: WorkStudent[];
  coverage: CoverageRevision[];
  informedCoverage: CoverageRevision[];
  informed: CompletionEvidence | null;
  active: boolean;
  version: number;
}

export interface WorkAssignment {
  id: string;
  teacherKey: string;
  teacherName: string;
  classDate: string;
  dueDate: string;
  ownerEmail: string | null;
  ownerName: string | null;
  assignedDate: string | null;
  version: number;
  sourceRequestIds: string[];
  classes: ClassWork[];
  families: FamilyWork[];
  done: boolean;
  issue: string | null;
}

export interface RosterPerson {
  key: string;
  name: string;
  email: string;
  status: string;
  shift: string | null;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
  unfinished: number;
  needsCover: number;
}

export interface LeaveBoard {
  date: string;
  today: string;
  viewerEmail: string;
  defaultOwner: string;
  roster: RosterPerson[];
  admins: Array<{ email: string; name: string }>;
  assignments: WorkAssignment[];
  history: Array<{ id: string; teacher: string; startDate: string | null; endDate: string | null; status: string | null; error: string | null }>;
  freshness: {
    sourceReadAt: string | null;
    classesReadAt: string | null;
    rosterReadAt: string | null;
    running: boolean;
    stale: boolean;
    errors: string[];
    pendingNormalization: number;
    failedNormalization: number;
    pendingWritebacks: number;
  };
}
