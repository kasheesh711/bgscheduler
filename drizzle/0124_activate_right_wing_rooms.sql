-- Right-wing rooms (floor plan PR #233). Production held them as inactive 1-seat placeholders;
-- ensureDefaultClassroomRooms() never changes `active`, so activation needs this one-off update.
WITH wing_rooms(name, sort_order) AS (
  VALUES
    ('Consistency Wins', 25),
    ('Shift', 26),
    ('Trust the Process', 27),
    ('Eureka', 28),
    ('Now', 29),
    ('Win or Learn', 30),
    ('Possible', 31),
    ('Momentum', 32),
    ('Try', 33),
    ('Gain', 34),
    ('Think Different', 35),
    ('Productive', 36)
)
INSERT INTO "classroom_rooms" ("name", "has_tv", "capacity", "category", "active", "sort_order", "created_at", "updated_at")
SELECT name, false, 2, 'standard', true, sort_order, now(), now()
FROM wing_rooms
ON CONFLICT ("name") DO UPDATE SET
  "has_tv" = false,
  "capacity" = 2,
  "category" = 'standard',
  "active" = true,
  "sort_order" = excluded."sort_order",
  "updated_at" = now();
