import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import type { WiseTeacher } from "@/lib/wise/types";

/** Roster details of one Wise teacher account that Tutor Offboarding scores on. Null = unknown (OFF-02). */
export interface RosterFact {
  wiseTeacherId: string;
  relation: string | null;
  joinedOn: Date | null;
  courseCount: number | null;
  activated: boolean | null;
}

/** Pure: the roster details of each teacher row, with anything missing or malformed left unknown. */
export function extractRosterFacts(teachers: WiseTeacher[]): RosterFact[] {
  return teachers.map((teacher) => {
    const user = typeof teacher.userId === "object" && teacher.userId !== null ? teacher.userId : null;
    const relation = typeof teacher.relation === "string" ? teacher.relation.trim().toUpperCase() : "";
    const joined = typeof teacher.joinedOn === "string" ? new Date(teacher.joinedOn) : null;
    return {
      wiseTeacherId: teacher._id,
      relation: relation || null,
      joinedOn: joined && !Number.isNaN(joined.getTime()) ? joined : null,
      courseCount: Array.isArray(teacher.classes) ? teacher.classes.length : null,
      activated: typeof user?.activated === "boolean" ? user.activated : null,
    };
  });
}

/**
 * Writes roster details onto `tutor_wise_accounts` in one statement and returns how many rows changed.
 * Accounts not on the roster (absent) are untouched and keep their last known values. The sync calls this
 * after promotion, outside the promotion transaction, and treats a failure as non-fatal.
 */
export async function persistRosterFacts(db: Database, facts: RosterFact[]): Promise<number> {
  if (facts.length === 0) return 0;
  const values = sql.join(facts.map((fact) => sql`(${fact.wiseTeacherId}::text, ${fact.relation}::text, ${
    fact.joinedOn ? fact.joinedOn.toISOString() : null}::timestamptz, ${fact.courseCount}::integer, ${fact.activated}::boolean)`), sql`, `);
  const result = await db.execute(sql`
    update tutor_wise_accounts as account set
      wise_relation = fact.relation,
      wise_joined_on = fact.joined_on,
      wise_course_count = fact.course_count,
      wise_activated = fact.activated
    from (values ${values}) as fact(wise_teacher_id, relation, joined_on, course_count, activated)
    where account.wise_teacher_id = fact.wise_teacher_id
      and (account.wise_relation, account.wise_joined_on, account.wise_course_count, account.wise_activated)
        is distinct from (fact.relation, fact.joined_on, fact.course_count, fact.activated)
    returning account.wise_teacher_id
  `);
  return result.rows.length;
}
