UPDATE "classroom_rooms"
SET "active" = false, "updated_at" = now()
WHERE "name" = 'Eureka';
--> statement-breakpoint
UPDATE "classroom_rooms"
SET "category" = 'overflow_only', "updated_at" = now()
WHERE "name" IN ('Dream. Plan. Do.', 'Trust the Process');
