import {randomUUID} from "node:crypto";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {sql} from "drizzle-orm";
import {startTestDb,stopTestDb,truncateAll} from "@/tests/integration/db-helper";
import type {Database} from "@/lib/db";
import * as s from "@/lib/db/schema";
import {sendProgressLineReminders,type ReminderCandidate} from "../progress-reminders";
let h:Awaited<ReturnType<typeof startTestDb>>,db:Database,now:Date,c:ReminderCandidate;
let push:ReturnType<typeof vi.fn>,load:ReturnType<typeof vi.fn>;
beforeAll(async()=>{h=await startTestDb();db=h.db as unknown as Database;},120000);
afterAll(async()=>{if(h)await stopTestDb(h);});
afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await truncateAll(h.db);vi.stubEnv("PROGRESS_LINE_REMINDERS_ENABLED","true");vi.stubEnv("PROGRESS_LINE_TUTOR_KEYS","Buzz");
 now=new Date("2026-10-13T14:00:00Z");c={ownerKey:"Buzz",tutorName:"Buzz",seriesId:randomUUID(),assessmentId:null,cycle:1,studentName:"Ari",courseName:"Maths",wiseClassId:"course",wiseStudentId:"student",lessonId:"lesson",scheduledAt:"2026-10-14T11:00:00Z",updatedAt:now.toISOString(),url:"https://www.begifted.app/#/progress-checks"};
 await db.insert(s.tutorContacts).values({canonicalKey:"Buzz",displayName:"Buzz"});
 await db.insert(s.progressLineGroups).values({canonicalKey:"Buzz",groupId:"buzz-group",groupName:"Kru Buzz x BeGifted",enabled:true,registeredBy:"admin"});
 push=vi.fn(async input=>({retryKey:input.retryKey,sentMessageId:"accepted",response:{sentMessages:[{id:"accepted"}]}}));load=vi.fn(async()=>[c]);
});
const run=()=>sendProgressLineReminders(db,{now:()=>now,load:load as never,push:push as never});
describe("durable LINE reminder delivery",()=>{
 it("sends the late trial once across concurrent invocations and records the expired week stage",async()=>{
  await Promise.all([run(),run(),run()]);await run();expect(push).toHaveBeenCalledTimes(1);
  const rows=await db.select().from(s.progressLineDeliveries);expect(rows.find(r=>r.stage==="week_before")?.status).toBe("missed");expect(rows.find(r=>r.stage==="night_before")?.providerMessageId).toBe("accepted");
 });
 it("holds messages before 19:00 and sends both stages on their correct dates",async()=>{
  c.scheduledAt="2026-10-20T11:00:00Z";now=new Date("2026-10-13T11:00:00Z");await run();expect(push).not.toHaveBeenCalled();
  now=new Date("2026-10-13T12:00:00Z");await run();expect(push).toHaveBeenCalledTimes(1);
  now=new Date("2026-10-19T12:00:00Z");await run();expect(push).toHaveBeenCalledTimes(2);expect(push.mock.calls[1][0].text).toContain("tomorrow");
 });
 it("retries a timeout using the original key, text and destination",async()=>{
  push.mockRejectedValueOnce(new Error("timeout"));await run();const original=push.mock.calls[0][0];
  now=new Date(now.getTime()+11*60000);await run();expect(push).toHaveBeenCalledTimes(2);expect(push.mock.calls[1][0]).toMatchObject({retryKey:original.retryKey,text:original.text,to:original.to});
  const rows=await db.select().from(s.progressLineDeliveries);expect(rows.find(r=>r.stage==="night_before")?.attempts).toBe(2);
 });
 it("cancels a changed unsent lesson and uses the new remaining reminder date",async()=>{
  now=new Date("2026-10-13T11:00:00Z");await run();c={...c,lessonId:"replacement",scheduledAt:"2026-10-15T11:00:00Z"};now=new Date("2026-10-14T12:00:00Z");await run();
  expect(push).toHaveBeenCalledTimes(1);expect(push.mock.calls[0][0].text).toContain("15 October");expect((await db.select().from(s.progressLineDeliveries)).some(r=>r.status==="cancelled")).toBe(true);
 });
 it("stops an attempted send when its lesson changes and keeps it for review",async()=>{
  push.mockRejectedValueOnce(new Error("timeout"));await run();c={...c,lessonId:"replacement"};now=new Date(now.getTime()+11*60000);await run();expect(push).toHaveBeenCalledTimes(1);expect((await db.select().from(s.progressLineDeliveries)).some(r=>r.status==="uncertain")).toBe(true);
 });
 it("rechecks the source before push and stops a newly submitted test",async()=>{
  load.mockResolvedValueOnce([c]).mockResolvedValue([]);await run();expect(push).not.toHaveBeenCalled();expect((await db.select().from(s.progressLineDeliveries)).some(r=>r.status==="cancelled")).toBe(true);
 });
 it("does not send after midnight or to another enabled tutor",async()=>{
  await db.insert(s.tutorContacts).values({canonicalKey:"Gift",displayName:"Gift"});await db.insert(s.progressLineGroups).values({canonicalKey:"Gift",groupId:"other-group",groupName:"Other",enabled:true,registeredBy:"admin"});
  now=new Date("2026-10-13T11:00:00Z");await run();now=new Date("2026-10-13T17:00:00Z");await run();expect(push).not.toHaveBeenCalled();expect(load.mock.calls.every(args=>args[0]==="Buzz")).toBe(true);
 });
 it("keeps a crashed send uncertain after the retry window",async()=>{
  await run();await db.execute(sql`update progress_line_deliveries set status='sending',lease_until=${new Date(now.getTime()-3600000)},first_attempt_at=${new Date(now.getTime()-25*3600000)},sent_at=null where stage='night_before'`);push.mockClear();await run();expect(push).not.toHaveBeenCalled();expect((await db.select().from(s.progressLineDeliveries)).find(r=>r.stage==="night_before")?.status).toBe("uncertain");
 });
 it("uses the feature switch to stop all reads and sends",async()=>{
  vi.stubEnv("PROGRESS_LINE_REMINDERS_ENABLED","false");expect(await run()).toMatchObject({disabled:true});expect(load).not.toHaveBeenCalled();expect(push).not.toHaveBeenCalled();
 });
});
