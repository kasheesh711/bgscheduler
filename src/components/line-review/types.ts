export type IntentType =
  | "all"
  | "new_request"
  | "cancel_one_off"
  | "pause_until"
  | "resume"
  | "reschedule"
  | "unclear_change";

export type ReviewStatus =
  | "pending_review"
  | "approved_sent"
  | "accepted_no_send"
  | "rejected"
  | "dismissed";

export type WritebackStatus =
  | "not_applicable"
  | "dry_run"
  | "manual_required"
  | "ready"
  | "confirmed"
  | "failed";

export interface Analytics {
  classifiedMessages: number;
  pendingReviews: number;
  rejected: number;
  approvedSent: number;
  acceptedNoSend: number;
  dismissed: number;
  rejectionRate: number;
  classificationAccuracy: number | null;
  unverifiedLinkBacklog: number;
}

export interface Review {
  id: string;
  contactId: string;
  lineUserId: string;
  contactDisplayName: string | null;
  classifierCategory: string;
  classifierConfidence: number | null;
  classifierSummary: string | null;
  classifierRationale: string | null;
  status: ReviewStatus;
  intentType: Exclude<IntentType, "all">;
  intentPayload: Record<string, unknown>;
  proposedDraft: string;
  finalText: string | null;
  selectedTutorIds: string[];
  studentLinkOverride: boolean;
  verifiedStudentKeys: string[];
  matchedStudentKeys: string[];
  candidateSessions: Record<string, unknown>[];
  proposedWiseActions: Record<string, unknown>[];
  adminSelectedSessionIds: string[];
  writebackStatus: WritebackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateSession {
  wiseSessionId: string;
  wiseClassId: string;
  studentKey: string;
  studentName: string;
  subject: string;
  packageName: string;
  startLocalDate: string;
  startLocalTime: string;
  endLocalTime: string | null;
  teacherName: string | null;
  location: string | null;
  score: number;
  reasons: string[];
}

export interface ProposedWiseAction {
  id: string;
  type: string;
  label: string;
  wiseSessionIds: string[];
  wiseClassIds: string[];
  endpointVerified: boolean;
  dryRun: boolean;
  disabledReason: string | null;
  payload: Record<string, unknown>;
}

export interface StudentLink {
  id: string;
  contactId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  status: "suggested" | "verified" | "rejected";
  confidence: number | null;
  currentStudentActivated: boolean | null;
  currentStudentHasFutureSessions: boolean | null;
  currentStudentHasLivePackage: boolean | null;
}

export interface StudentDirectoryRow {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  activated: boolean;
  hasFutureSessions: boolean;
  hasLivePackage: boolean;
  matchType?: string;
}

export interface WiseActionLog {
  id: string;
  actionType: string;
  status: string;
  dryRun: boolean;
  wiseSessionIds: string[];
  errorMessage: string | null;
  createdAt: string;
}

export interface ChatContextMessage {
  id: string;
  source: "line" | "website";
  roleLabel: string;
  text: string;
  timestamp: string;
  direction: "inbound" | "outbound" | null;
  role: "admin" | "parent" | "assistant" | "system" | null;
  messageType: string | null;
  isRetracted: boolean;
  createdByEmail: string | null;
  createdByName: string | null;
}

export interface LineReviewChatContext {
  reviewId: string;
  threadId: string;
  conversationId: string | null;
  lineMessages: ChatContextMessage[];
  websiteMessages: ChatContextMessage[];
  combinedTimeline: ChatContextMessage[];
}

export interface FalseNegativeCandidate {
  id: string;
  contactDisplayName: string | null;
  lineUserId: string;
  text: string;
  classifierCategory: string | null;
  classifierConfidence: number | null;
}

export interface AliasImportContactCandidate {
  contactId: string;
  lineUserId: string;
  displayName: string | null;
  linkedStudentLabel: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  score: number;
  reasons: string[];
}

export interface AliasImportSuggestedStudent {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  matchedCode: string;
  matchedField: string;
  activated: boolean;
  hasFutureSessions: boolean;
  hasLivePackage: boolean;
}

export interface AliasImportPreviewRow {
  rowId: string;
  aliasLabel: string;
  latestMessagePreview: string | null;
  timeLabel: string | null;
  rawText: string;
  sourceType?: "text" | "image";
  sourceName?: string;
  sourceIndex?: number;
  sourceRowId?: string;
  duplicateCount?: number;
  parsedCodes: Array<{ raw: string; code: string; normalized: string }>;
  suggestedStudents: AliasImportSuggestedStudent[];
  contactCandidates: AliasImportContactCandidate[];
  autoSelectedContactId: string | null;
}

export interface AliasImportPreview {
  source: "text" | "image";
  rows: AliasImportPreviewRow[];
}

export type LineOaResolverRunStatus = "active" | "committed" | "expired";
export type LineOaResolverRowStatus =
  | "pending"
  | "matched"
  | "ambiguous"
  | "no_match"
  | "error"
  | "needs_manual_code"
  | "committed";

export interface LineOaResolverRow {
  id: string;
  runId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  searchCode: string | null;
  status: LineOaResolverRowStatus;
  lineOaAccountId: string | null;
  lineUserId: string | null;
  lineChatUrl: string | null;
  chatTitle: string | null;
  matchMode: string | null;
  captureMode: string | null;
  errorMessage: string | null;
  evidence: Record<string, unknown>;
  committedContactId: string | null;
  committedLinkId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LineOaResolverRun {
  id: string;
  status: LineOaResolverRunStatus;
  tokenPrefix: string;
  worklistSource: string;
  totalRows: number;
  pendingRows: number;
  matchedRows: number;
  ambiguousRows: number;
  noMatchRows: number;
  errorRows: number;
  needsManualCodeRows: number;
  committedRows: number;
  createdByEmail: string | null;
  createdByName: string | null;
  expiresAt: string;
  committedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rows: LineOaResolverRow[];
}
