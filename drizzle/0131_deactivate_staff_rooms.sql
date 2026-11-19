UPDATE "classroom_rooms"
SET "active" = false, "updated_at" = now()
WHERE "name" IN ('Now', 'Productive') AND "active";
