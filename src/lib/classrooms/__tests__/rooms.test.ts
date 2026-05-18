import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASSROOM_ROOMS,
  TV_ROOM_NAME_BY_PHYSICAL_NAME,
} from "../rooms";

describe("classroom room catalog", () => {
  it("uses canonical TV-suffixed local names for active TV-capable rooms", () => {
    const activeRoomNames = new Set(DEFAULT_CLASSROOM_ROOMS.filter((room) => room.active).map((room) => room.name));

    for (const [physicalName, tvName] of TV_ROOM_NAME_BY_PHYSICAL_NAME) {
      expect(activeRoomNames).not.toContain(physicalName);
      expect(activeRoomNames).toContain(tvName);
      expect(DEFAULT_CLASSROOM_ROOMS.find((room) => room.name === tvName)).toMatchObject({
        hasTv: true,
        active: true,
      });
    }
  });

  it("ships a migration that repairs historical local room names", () => {
    const migration = readFileSync(new URL("../../../../drizzle/0012_adopt_tv_room_names.sql", import.meta.url), "utf8");

    expect(migration).toContain('UPDATE "classroom_rooms"');
    expect(migration).toContain('UPDATE "classroom_assignment_rows"');
    expect(migration).toContain('"assigned_room"');
    expect(migration).toContain('"override_room"');
    expect(migration).toContain('"preferred_room"');
  });
});
