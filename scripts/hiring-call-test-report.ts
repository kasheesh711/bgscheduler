import { loadEnvConfig } from "@next/env";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";

/**
 * The result of the call-skip test (Kevin, 24 Nov 2026), for the owner only. Read-only. It prints counts for each route
 * and no names. Run: `npx tsx --tsconfig scripts/tsconfig.json scripts/hiring-call-test-report.ts`.
 */
async function main() {
  loadEnvConfig(process.cwd());
  const { rows } = await getDb().execute(sql`
    with per as (
      select t.arm, t.assigned_at, c.stage,
        exists (select 1 from hiring_bookings b where b.candidate_id = c.id and b.kind = 'call' and b.status <> 'cancelled') as call_booked,
        (c.call_review -> 'good' ->> 'at') is not null as call_good,
        (select min(o.sent_at) from hiring_outbox o where o.key = c.id::text || ':pre-screen' and o.status = 'sent') as form_sent,
        c.pre_screen_replied_at as form_in,
        (select min(o.sent_at) from hiring_outbox o where o.candidate_id = c.id and o.payload ->> 'workflowStage' = 'onsite_invited' and o.status = 'sent') as visit_invited,
        (select min(b.created_at) from hiring_bookings b where b.candidate_id = c.id and b.kind in ('paper', 'mock') and b.status = 'confirmed') as visit_booked,
        (select max(b.end_time) from hiring_bookings b where b.candidate_id = c.id and b.kind = 'mock' and b.status = 'confirmed' and b.end_time < now()) as visited,
        (select a.detail ->> 'decision' from hiring_audit a where a.candidate_id = c.id and a.action = 'head-decision' order by a.created_at desc limit 1) as head
      from hiring_call_test t join hiring_candidates c on c.id = t.candidate_id
    )
    select arm,
      count(*)::int as assigned,
      count(*) filter (where call_booked)::int as call_booked,
      count(*) filter (where call_good)::int as call_good,
      count(form_sent)::int as form_sent,
      count(form_in)::int as form_in,
      count(visit_invited)::int as visit_invited,
      count(visit_booked)::int as visit_booked,
      count(visited)::int as visited,
      count(*) filter (where head = 'hire')::int as head_yes,
      count(*) filter (where head = 'reject')::int as head_no,
      count(*) filter (where stage = 'hired')::int as hired,
      count(*) filter (where stage in ('stopped', 'rejected', 'no_reply', 'no_booking', 'review'))::int as left_the_pipeline,
      round((percentile_cont(0.5) within group (order by extract(epoch from form_sent - assigned_at) / 86400))::numeric, 1) as median_days_to_form_sent,
      round((percentile_cont(0.5) within group (order by extract(epoch from form_in - assigned_at) / 86400))::numeric, 1) as median_days_to_form_in,
      round((percentile_cont(0.5) within group (order by extract(epoch from visit_booked - assigned_at) / 86400))::numeric, 1) as median_days_to_visit_booked
    from per group by arm order by arm`);
  if (!rows.length) console.log("No candidate is in the test yet.");
  else console.table(rows);
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.name : "failed");
    process.exit(1);
  },
);
