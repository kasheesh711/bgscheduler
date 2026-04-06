import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { adminUsers, tutorAliases } from "./schema";

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = neon(databaseUrl);
  const db = drizzle({ client: sql });

  console.log("Seeding tutor aliases...");
  const aliases = [
    { fromKey: "Kev", toKey: "Kevin" },
    { fromKey: "Paoju", toKey: "Paojuu" },
    { fromKey: "Poi", toKey: "Nacha (Poi)" },
    { fromKey: "Sam", toKey: "Samantha" },
  ];

  for (const alias of aliases) {
    await db
      .insert(tutorAliases)
      .values(alias)
      .onConflictDoNothing({ target: tutorAliases.fromKey });
  }
  console.log(`Seeded ${aliases.length} aliases`);

  // Seed admin users - add your admin emails here
  const adminEmails = process.env.SEED_ADMIN_EMAILS?.split(",").filter(Boolean) ?? [];
  if (adminEmails.length > 0) {
    console.log("Seeding admin users...");
    for (const email of adminEmails) {
      await db
        .insert(adminUsers)
        .values({ email: email.trim() })
        .onConflictDoNothing({ target: adminUsers.email });
    }
    console.log(`Seeded ${adminEmails.length} admin users`);
  } else {
    console.log("No SEED_ADMIN_EMAILS set, skipping admin user seed");
  }

  console.log("Seed complete");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
