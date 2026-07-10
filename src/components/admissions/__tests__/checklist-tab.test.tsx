import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  CUSTOM_PHASE_LABEL,
  ChecklistTab,
  canToggleTask,
  computeTaskProgress,
  describeRecurrence,
  groupTasksByPhase,
  isTaskOverdue,
  mergeTaskOverrides,
} from "../checklist-tab";
import {
  EMPTY_CUSTOM_TASK_FORM,
  buildCustomTaskPayload,
  type CustomTaskFormValues,
} from "../custom-task-dialog";
import type {
  AdmissionsChecklistProgress,
  AdmissionsTaskDto,
} from "@/lib/admissions/checklists";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";
const TEMPLATE_ID = "88888888-8888-4888-8888-888888888888";

function makeTask(
  overrides: Partial<AdmissionsTaskDto> & { id: string },
): AdmissionsTaskDto {
  return {
    caseId: CASE_ID,
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    itemKey: "template_item",
    phase: "about_you",
    title: "Task",
    description: null,
    owner: "student",
    status: "not_started",
    dueDate: null,
    verifiedByEmail: null,
    verifiedAt: null,
    recurrence: null,
    sortOrder: 0,
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    ...overrides,
  };
}

// Template-derived, student-owned, done + verified.
const VERIFIED_TASK = makeTask({
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  itemKey: "complete_intake_questionnaire",
  phase: "about_you",
  title: "Complete the intake questionnaire",
  owner: "student",
  status: "done",
  verifiedByEmail: "counselor.may@example.com",
  verifiedAt: "2026-07-02T03:00:00.000Z",
});

// Template-derived, counselor-owned, always-overdue due date.
const OVERDUE_TASK = makeTask({
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  itemKey: "record_current_transcript",
  phase: "academics",
  title: "Record the current transcript",
  owner: "counselor",
  status: "not_started",
  dueDate: "2000-01-01",
});

// Template-derived, student-owned, far-future due date (never overdue).
const FUTURE_TASK = makeTask({
  id: "33333333-cccc-4ccc-8ccc-333333333333",
  itemKey: "draft_personal_statement",
  phase: "essays",
  title: "Draft the personal statement",
  owner: "student",
  status: "in_progress",
  dueDate: "2999-12-31",
});

// Custom (no template linkage), counselor-owned, weekly recurrence.
const CUSTOM_TASK = makeTask({
  id: "44444444-dddd-4ddd-8ddd-444444444444",
  templateId: null,
  templateVersion: null,
  itemKey: null,
  phase: "custom",
  title: "Weekly essay check-in",
  owner: "counselor",
  recurrence: { freq: "weekly", until: "2026-12-31" },
});

// Unknown phase — must fail closed into the custom group.
const UNKNOWN_PHASE_TASK = makeTask({
  id: "55555555-eeee-4eee-8eee-555555555555",
  templateId: null,
  templateVersion: null,
  itemKey: null,
  phase: "bogus_phase",
  title: "Mystery phase task",
  owner: "student",
});

const ALL_TASKS = [
  VERIFIED_TASK,
  OVERDUE_TASK,
  FUTURE_TASK,
  CUSTOM_TASK,
  UNKNOWN_PHASE_TASK,
];

const ZERO_PROGRESS: AdmissionsChecklistProgress = {
  done: 0,
  total: 0,
  percent: 0,
  verifiedCount: 0,
};

function renderTab(overrides: {
  tasks?: AdmissionsTaskDto[];
  viewerRole?: CaseRole;
  progress?: AdmissionsChecklistProgress;
} = {}): string {
  return renderToStaticMarkup(
    <ChecklistTab
      caseId={CASE_ID}
      tasks={overrides.tasks ?? ALL_TASKS}
      progress={overrides.progress ?? ZERO_PROGRESS}
      viewerRole={overrides.viewerRole ?? "counselor"}
    />,
  );
}

function findCheckbox(html: string, taskId: string): string {
  const match = html.match(
    new RegExp(`<input[^>]*data-testid="task-checkbox-${taskId}"[^>]*>`),
  );
  expect(match).not.toBeNull();
  return match![0];
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("groupTasksByPhase", () => {
  it("groups tasks into canonical phases in order, skipping empty phases", () => {
    const groups = groupTasksByPhase(ALL_TASKS);
    expect(groups.map((group) => group.key)).toEqual([
      "about_you",
      "academics",
      "essays",
      "custom",
    ]);
    expect(groups[0].label).toBe("About You");
    expect(groups[0].tasks).toEqual([VERIFIED_TASK]);
    expect(groups[1].tasks).toEqual([OVERDUE_TASK]);
  });

  it("routes custom and unknown phases into the trailing custom group (fail-closed)", () => {
    const groups = groupTasksByPhase(ALL_TASKS);
    const custom = groups[groups.length - 1];
    expect(custom.key).toBe("custom");
    expect(custom.label).toBe(CUSTOM_PHASE_LABEL);
    expect(custom.tasks).toEqual([CUSTOM_TASK, UNKNOWN_PHASE_TASK]);
  });

  it("returns an empty list for no tasks", () => {
    expect(groupTasksByPhase([])).toEqual([]);
  });
});

describe("computeTaskProgress", () => {
  it("returns the zero rollup for an empty list", () => {
    expect(computeTaskProgress([])).toEqual(ZERO_PROGRESS);
  });

  it("counts done, verified, and rounds percent (CM-24 mirror)", () => {
    const progress = computeTaskProgress(ALL_TASKS);
    expect(progress.total).toBe(5);
    expect(progress.done).toBe(1);
    expect(progress.percent).toBe(20);
    expect(progress.verifiedCount).toBe(1);
  });

  it("counts verified separately from done", () => {
    const progress = computeTaskProgress([
      makeTask({ id: "a1", status: "not_started", verifiedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(progress.done).toBe(0);
    expect(progress.verifiedCount).toBe(1);
  });
});

describe("isTaskOverdue", () => {
  it("is overdue only when the due date is strictly before today and not done", () => {
    expect(isTaskOverdue({ dueDate: "2026-07-08", status: "not_started" }, "2026-07-09")).toBe(true);
    expect(isTaskOverdue({ dueDate: "2026-07-08", status: "in_progress" }, "2026-07-09")).toBe(true);
    expect(isTaskOverdue({ dueDate: "2026-07-10", status: "not_started" }, "2026-07-09")).toBe(false);
  });

  it("never flags done tasks, undated tasks, or same-day due dates", () => {
    expect(isTaskOverdue({ dueDate: "2026-07-08", status: "done" }, "2026-07-09")).toBe(false);
    expect(isTaskOverdue({ dueDate: null, status: "not_started" }, "2026-07-09")).toBe(false);
    expect(isTaskOverdue({ dueDate: "2026-07-09", status: "not_started" }, "2026-07-09")).toBe(false);
  });
});

describe("canToggleTask", () => {
  it("blocks parents from every task (view-only)", () => {
    expect(canToggleTask("parent", { owner: "student" })).toBe(false);
    expect(canToggleTask("parent", { owner: "parent" })).toBe(false);
    expect(canToggleTask("parent", { owner: "counselor" })).toBe(false);
  });

  it("lets students toggle only student-owned tasks (CM-22)", () => {
    expect(canToggleTask("student", { owner: "student" })).toBe(true);
    expect(canToggleTask("student", { owner: "counselor" })).toBe(false);
    expect(canToggleTask("student", { owner: "parent" })).toBe(false);
  });

  it("lets counselors and admins toggle any task", () => {
    for (const role of ["counselor", "admin"] as const) {
      expect(canToggleTask(role, { owner: "student" })).toBe(true);
      expect(canToggleTask(role, { owner: "counselor" })).toBe(true);
      expect(canToggleTask(role, { owner: "parent" })).toBe(true);
    }
  });
});

describe("mergeTaskOverrides", () => {
  it("replaces a base task when the override is at least as fresh", () => {
    const override = { ...OVERDUE_TASK, status: "done" as const };
    const merged = mergeTaskOverrides([OVERDUE_TASK], { [OVERDUE_TASK.id]: override });
    expect(merged).toEqual([override]);
  });

  it("keeps the base task when the server row is fresher than the override", () => {
    const staleOverride = {
      ...OVERDUE_TASK,
      status: "done" as const,
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const freshBase = { ...OVERDUE_TASK, updatedAt: "2026-07-08T00:00:00.000Z" };
    const merged = mergeTaskOverrides([freshBase], { [OVERDUE_TASK.id]: staleOverride });
    expect(merged).toEqual([freshBase]);
  });

  it("hides tasks with a null override (optimistic delete)", () => {
    const merged = mergeTaskOverrides([CUSTOM_TASK, OVERDUE_TASK], {
      [CUSTOM_TASK.id]: null,
    });
    expect(merged).toEqual([OVERDUE_TASK]);
  });

  it("appends overrides whose id is not in the base list (optimistic create)", () => {
    const merged = mergeTaskOverrides([OVERDUE_TASK], { [CUSTOM_TASK.id]: CUSTOM_TASK });
    expect(merged).toEqual([OVERDUE_TASK, CUSTOM_TASK]);
  });
});

describe("describeRecurrence", () => {
  it("formats weekly and biweekly recurrences with a D/M/YYYY end date", () => {
    expect(describeRecurrence({ freq: "weekly", until: "2026-12-31" })).toBe(
      "Weekly until 31/12/2026",
    );
    expect(describeRecurrence({ freq: "biweekly", until: "2027-01-05" })).toBe(
      "Biweekly until 5/1/2027",
    );
  });
});

describe("buildCustomTaskPayload", () => {
  it("rejects a blank title", () => {
    const result = buildCustomTaskPayload({ ...EMPTY_CUSTOM_TASK_FORM, title: "   " });
    expect(result).toEqual({ ok: false, error: "Task title is required." });
  });

  it("rejects a recurrence without an end date", () => {
    const form: CustomTaskFormValues = {
      ...EMPTY_CUSTOM_TASK_FORM,
      title: "Check in",
      recurrenceFreq: "weekly",
      recurrenceUntil: "",
    };
    expect(buildCustomTaskPayload(form)).toEqual({
      ok: false,
      error: "Recurring tasks need an end date.",
    });
  });

  it("serializes blanks as null and none-recurrence as null", () => {
    const result = buildCustomTaskPayload({ ...EMPTY_CUSTOM_TASK_FORM, title: " Check in " });
    expect(result).toEqual({
      ok: true,
      body: {
        title: "Check in",
        description: null,
        owner: "student",
        dueDate: null,
        recurrence: null,
      },
    });
  });

  it("builds a full body with recurrence and due date", () => {
    const form: CustomTaskFormValues = {
      title: "Weekly essay check-in",
      description: " Bring the latest draft. ",
      owner: "counselor",
      dueDate: "2026-08-01",
      recurrenceFreq: "biweekly",
      recurrenceUntil: "2026-12-31",
    };
    expect(buildCustomTaskPayload(form)).toEqual({
      ok: true,
      body: {
        title: "Weekly essay check-in",
        description: "Bring the latest draft.",
        owner: "counselor",
        dueDate: "2026-08-01",
        recurrence: { freq: "biweekly", until: "2026-12-31" },
      },
    });
  });
});

// ── Rendering: counselor ────────────────────────────────────────────────

describe("ChecklistTab counselor view", () => {
  it("renders collapsible phase sections with per-phase done counts", () => {
    const html = renderTab();
    expect(html).toContain('data-testid="phase-header-about_you"');
    expect(html).toContain('data-testid="phase-header-academics"');
    expect(html).toContain('data-testid="phase-header-essays"');
    expect(html).toContain('data-testid="phase-header-custom"');
    expect(html).toContain("About You");
    // "&" is HTML-escaped by renderToStaticMarkup.
    expect(html).toContain(CUSTOM_PHASE_LABEL.replace("&", "&amp;"));
    // Sections start expanded with aria-expanded on the header buttons.
    expect(html).toContain('aria-expanded="true"');
    // About You: its one task is done.
    expect(html).toContain("1/1 done");
    // Header rollup reflects all tasks.
    expect(html).toContain("1/5 tasks done");
    expect(html).toContain("1 verified");
  });

  it("shows the add-task action and enabled checkboxes on every task", () => {
    const html = renderTab();
    expect(html).toContain('data-testid="checklist-add-task"');
    for (const task of ALL_TASKS) {
      expect(findCheckbox(html, task.id)).not.toContain("disabled");
    }
  });

  it("badges verified tasks distinctly", () => {
    const html = renderTab();
    expect(html).toContain('data-testid="verified-badge"');
    expect(html).toContain("Verified");
    // Exactly one verified badge across the fixtures.
    expect(html.match(/data-testid="verified-badge"/g)).toHaveLength(1);
  });

  it("styles overdue due dates with the conflict token and an Overdue marker", () => {
    const html = renderTab();
    const overdueSpan = html.match(
      new RegExp(`<span[^>]*data-testid="task-due-${OVERDUE_TASK.id}"[^>]*>`),
    );
    expect(overdueSpan).not.toBeNull();
    expect(overdueSpan![0]).toContain("text-conflict");
    expect(html).toContain("· Overdue");

    const futureSpan = html.match(
      new RegExp(`<span[^>]*data-testid="task-due-${FUTURE_TASK.id}"[^>]*>`),
    );
    expect(futureSpan).not.toBeNull();
    expect(futureSpan![0]).not.toContain("text-conflict");
  });

  it("offers delete only on custom tasks, never on template-derived ones", () => {
    const html = renderTab();
    expect(html).toContain(`Delete task ${CUSTOM_TASK.title}`);
    expect(html).toContain(`Delete task ${UNKNOWN_PHASE_TASK.title}`);
    expect(html).not.toContain(`Delete task ${VERIFIED_TASK.title}`);
    expect(html).not.toContain(`Delete task ${OVERDUE_TASK.title}`);
    expect(html).not.toContain(`Delete task ${FUTURE_TASK.title}`);
  });

  it("offers the verification toggle only on student-owned tasks", () => {
    const html = renderTab();
    expect(html).toContain(`Remove verification from ${VERIFIED_TASK.title}`);
    expect(html).toContain(`Verify ${FUTURE_TASK.title}`);
    expect(html).not.toContain(`Verify ${OVERDUE_TASK.title}`);
    expect(html).not.toContain(`Verify ${CUSTOM_TASK.title}`);
  });

  it("shows the recurrence badge on recurring tasks", () => {
    const html = renderTab();
    expect(html).toContain("Weekly until 31/12/2026");
  });

  it("renders a staff empty state when there are no tasks", () => {
    const html = renderTab({ tasks: [] });
    expect(html).toContain("No checklist tasks yet");
    expect(html).toContain('data-testid="checklist-add-task"');
  });
});

// ── Rendering: student ──────────────────────────────────────────────────

describe("ChecklistTab student view", () => {
  it("enables checkboxes only on student-owned tasks", () => {
    const html = renderTab({ viewerRole: "student" });
    expect(findCheckbox(html, VERIFIED_TASK.id)).not.toContain("disabled");
    expect(findCheckbox(html, FUTURE_TASK.id)).not.toContain("disabled");
    expect(findCheckbox(html, UNKNOWN_PHASE_TASK.id)).not.toContain("disabled");
    expect(findCheckbox(html, OVERDUE_TASK.id)).toContain("disabled");
    expect(findCheckbox(html, CUSTOM_TASK.id)).toContain("disabled");
  });

  it("hides staff-only affordances (add, verify, delete)", () => {
    const html = renderTab({ viewerRole: "student" });
    expect(html).not.toContain('data-testid="checklist-add-task"');
    expect(html).not.toContain(`Verify ${FUTURE_TASK.title}`);
    expect(html).not.toContain("Delete task");
  });

  it("still shows the verified badge on verified tasks", () => {
    const html = renderTab({ viewerRole: "student" });
    expect(html).toContain('data-testid="verified-badge"');
  });
});

// ── Rendering: parent ───────────────────────────────────────────────────

describe("ChecklistTab parent view", () => {
  it("renders a read-only progress summary with no task rows", () => {
    const html = renderTab({
      viewerRole: "parent",
      tasks: [],
      progress: { done: 3, total: 10, percent: 30, verifiedCount: 2 },
    });
    expect(html).toContain("3/10 tasks done");
    expect(html).toContain("30%");
    expect(html).toContain("managed by the student and counselor");
    expect(html).not.toContain('data-testid="task-row"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('data-testid="checklist-add-task"');
  });
});
