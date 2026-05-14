import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssignmentTimelineControls } from "../assignment-timeline-controls";
import { RoomOccupancyHeatmap } from "../room-occupancy-heatmap";
import type { ClassroomRoom, ClassroomRow } from "../types";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function room(overrides: Partial<ClassroomRoom> = {}): ClassroomRoom {
  return {
    id: overrides.id ?? "room-1",
    name: overrides.name ?? "Focus",
    hasTv: overrides.hasTv ?? false,
    capacity: overrides.capacity ?? 2,
    category: overrides.category ?? "standard",
    active: overrides.active ?? true,
    sortOrder: overrides.sortOrder ?? 1,
  };
}

function row(overrides: Partial<ClassroomRow> = {}): ClassroomRow {
  return {
    id: overrides.id ?? "row-1",
    runId: overrides.runId ?? "run-1",
    tutorDisplayName: overrides.tutorDisplayName ?? "Tutor One",
    wiseTeacherId: overrides.wiseTeacherId ?? "teacher-1",
    wiseTeacherUserId: overrides.wiseTeacherUserId ?? "user-1",
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    wiseClassId: overrides.wiseClassId ?? "class-1",
    startTime: overrides.startTime ?? "2026-05-14T09:00:00.000Z",
    endTime: overrides.endTime ?? "2026-05-14T10:00:00.000Z",
    weekday: overrides.weekday ?? 4,
    startMinute: overrides.startMinute ?? 9 * 60,
    endMinute: overrides.endMinute ?? 10 * 60,
    wiseStatus: overrides.wiseStatus ?? "CONFIRMED",
    sessionType: overrides.sessionType ?? "OFFLINE",
    currentWiseLocation: overrides.currentWiseLocation ?? null,
    studentName: overrides.studentName ?? "Student One",
    studentCount: overrides.studentCount ?? 1,
    subject: overrides.subject ?? "Math",
    classType: overrides.classType ?? "ONE_TO_ONE",
    title: overrides.title ?? "Math",
    minCapacity: overrides.minCapacity ?? 1,
    needsTv: overrides.needsTv ?? false,
    preferredRoom: overrides.preferredRoom ?? null,
    overrideRoom: overrides.overrideRoom ?? null,
    assignedRoom: overrides.assignedRoom ?? "Focus",
    status: overrides.status ?? "assigned",
    warnings: overrides.warnings ?? [],
    publishStatus: overrides.publishStatus ?? "not_published",
    publishError: overrides.publishError ?? null,
  };
}

describe("class assignment visualization components", () => {
  it("renders timeline controls with playback and scrubber labels", () => {
    const html = renderToStaticMarkup(
      <AssignmentTimelineControls
        bounds={{ startMinute: 420, endMinute: 1260, initialMinute: 540 }}
        currentMinute={540}
        playing={false}
        speed={15}
        disabled={false}
        onMinuteChange={vi.fn()}
        onPlayingChange={vi.fn()}
        onReset={vi.fn()}
        onSpeedChange={vi.fn()}
      />,
    );

    expect(html).toContain("Play");
    expect(html).toContain("09:00");
    expect(html).toContain("aria-label=\"Schedule playback time\"");
    expect(html).toContain("15m/s");
  });

  it("renders heat-map cells with room and time accessibility labels", () => {
    const html = renderToStaticMarkup(
      <RoomOccupancyHeatmap
        rows={[row()]}
        rooms={[room()]}
        bounds={{ startMinute: 540, endMinute: 570, initialMinute: 540 }}
        currentMinute={540}
        onMinuteSelect={vi.fn()}
      />,
    );

    expect(html).toContain("Room heat map");
    expect(html).toContain("Focus 09:00 to 09:15, 1 session(s)");
    expect(html).toContain("Focus 09:15 to 09:30, 1 session(s)");
  });

  it("keeps floor-plan source accessible and independent from the uploaded image", () => {
    const source = read("src/components/class-assignments/floor-plan-occupancy.tsx");
    const geometry = read("src/lib/classrooms/floor-plan.ts");

    expect(source).toContain('aria-label="Interactive BeGifted floor plan occupancy"');
    expect(source).toContain("role=\"button\"");
    expect(source).not.toContain("ChatGPT Image");
    expect(geometry).toContain("Parent Waiting Area");
    expect(geometry).toContain("assignable: false");
  });

  it("keeps calendar source side-by-side, internally scrollable, and conflict-aware", () => {
    const source = read("src/components/class-assignments/room-calendar-view.tsx");

    expect(source).toContain("overflow-auto");
    expect(source).toContain("repeat(${roomNames.length}");
    expect(source).toContain("sticky left-0");
    expect(source).toContain("hasRoomConflict");
    expect(source).toContain("Review lane");
  });

  it("keeps animation native and reduced-motion-aware without adding animation dependencies", () => {
    const workspace = read("src/components/class-assignments/class-assignments-workspace.tsx");
    const floorPlan = read("src/components/class-assignments/floor-plan-occupancy.tsx");
    const calendar = read("src/components/class-assignments/room-calendar-view.tsx");
    const packageJson = read("package.json");

    expect(workspace).toContain("requestAnimationFrame");
    expect(floorPlan).toContain("motion-reduce:transition-none");
    expect(calendar).toContain("motion-reduce:transition-none");
    expect(packageJson).not.toContain("framer-motion");
    expect(packageJson).not.toContain('"motion"');
    expect(packageJson).not.toContain("@react-spring");
  });
});
