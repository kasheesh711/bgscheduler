WITH tv_rooms(physical_name, tv_name, capacity, sort_order) AS (
  VALUES
    ('Iconic', 'Iconic (TV)', 2, 6),
    ('Joy', 'Joy (TV)', 3, 8),
    ('Keep Going', 'Keep Going (TV)', 3, 9),
    ('Never Ever', 'Never Ever (TV)', 3, 11),
    ('Relax', 'Relax (TV)', 8, 13),
    ('Turn The Page', 'Turn The Page (TV)', 2, 17),
    ('Remember', 'Remember (TV)', 2, 18),
    ('Here There', 'Here There (TV)', 2, 19),
    ('Go All In', 'Go All In (TV)', 2, 20),
    ('Doubt', 'Doubt (TV)', 2, 21),
    ('Big Memories', 'Big Memories (TV)', 2, 22)
)
INSERT INTO "classroom_rooms" ("name", "has_tv", "capacity", "category", "active", "sort_order", "created_at", "updated_at")
SELECT tv_name, true, capacity, 'standard', true, sort_order, now(), now()
FROM tv_rooms
ON CONFLICT ("name") DO UPDATE SET
  "has_tv" = true,
  "capacity" = excluded."capacity",
  "category" = excluded."category",
  "active" = true,
  "sort_order" = excluded."sort_order",
  "updated_at" = now();
--> statement-breakpoint
WITH tv_rooms(physical_name, tv_name) AS (
  VALUES
    ('Iconic', 'Iconic (TV)'),
    ('Joy', 'Joy (TV)'),
    ('Keep Going', 'Keep Going (TV)'),
    ('Never Ever', 'Never Ever (TV)'),
    ('Relax', 'Relax (TV)'),
    ('Turn The Page', 'Turn The Page (TV)'),
    ('Remember', 'Remember (TV)'),
    ('Here There', 'Here There (TV)'),
    ('Go All In', 'Go All In (TV)'),
    ('Doubt', 'Doubt (TV)'),
    ('Big Memories', 'Big Memories (TV)')
)
UPDATE "classroom_rooms"
SET "active" = false, "updated_at" = now()
WHERE "name" IN (SELECT physical_name FROM tv_rooms);
--> statement-breakpoint
WITH tv_rooms(physical_name, tv_name) AS (
  VALUES
    ('Iconic', 'Iconic (TV)'),
    ('Joy', 'Joy (TV)'),
    ('Keep Going', 'Keep Going (TV)'),
    ('Never Ever', 'Never Ever (TV)'),
    ('Relax', 'Relax (TV)'),
    ('Turn The Page', 'Turn The Page (TV)'),
    ('Remember', 'Remember (TV)'),
    ('Here There', 'Here There (TV)'),
    ('Go All In', 'Go All In (TV)'),
    ('Doubt', 'Doubt (TV)'),
    ('Big Memories', 'Big Memories (TV)')
)
UPDATE "classroom_assignment_rows" AS rows
SET
  "assigned_room" = COALESCE(
    (SELECT tv_name FROM tv_rooms WHERE physical_name = rows."assigned_room"),
    rows."assigned_room"
  ),
  "override_room" = CASE
    WHEN rows."override_room" IS NULL THEN NULL
    ELSE COALESCE(
      (SELECT tv_name FROM tv_rooms WHERE physical_name = rows."override_room"),
      rows."override_room"
    )
  END,
  "preferred_room" = CASE
    WHEN rows."preferred_room" IS NULL THEN NULL
    ELSE COALESCE(
      (SELECT tv_name FROM tv_rooms WHERE physical_name = rows."preferred_room"),
      rows."preferred_room"
    )
  END,
  "updated_at" = now()
WHERE rows."assigned_room" IN (SELECT physical_name FROM tv_rooms)
  OR rows."override_room" IN (SELECT physical_name FROM tv_rooms)
  OR rows."preferred_room" IN (SELECT physical_name FROM tv_rooms);
