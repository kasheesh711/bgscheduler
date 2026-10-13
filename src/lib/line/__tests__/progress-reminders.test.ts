import {afterEach,describe,expect,it,vi} from "vitest";
import {handleProgressGroupCommand,parseReminderSnapshot,reminderAction,reminderDate,reminderText,sameOccurrence,type ReminderCandidate} from "../progress-reminders";
const now=new Date("2026-10-13T14:40:00Z");
const candidate:ReminderCandidate={ownerKey:"Buzz",tutorName:"Buzz",seriesId:"00000000-0000-4000-8000-000000000001",assessmentId:null,cycle:1,studentName:"Student",courseName:"Maths",wiseClassId:"course",wiseStudentId:"student",lessonId:"lesson",scheduledAt:"2026-10-14T11:00:00Z",updatedAt:now.toISOString(),url:"https://www.begifted.app/#/progress-checks"};
const snapshot=()=>({schemaVersion:1,ownerKey:"Buzz",observedAt:now.toISOString(),syncFinishedAt:now.toISOString(),candidates:[candidate]});
afterEach(()=>vi.unstubAllEnvs());
describe("Progress Check reminder rules",()=>{
 it("uses Bangkok calendar dates for both stages and the midnight boundary",()=>{
  expect(reminderDate(candidate,"week_before")).toBe("2026-10-07");expect(reminderDate(candidate,"night_before")).toBe("2026-10-13");
  expect(reminderAction("2026-10-13",new Date("2026-10-13T11:59:59Z"))).toBe("wait");
  expect(reminderAction("2026-10-13",new Date("2026-10-13T12:00:00Z"))).toBe("send");
  expect(reminderAction("2026-10-13",new Date("2026-10-13T16:59:59Z"))).toBe("send");
  expect(reminderAction("2026-10-13",new Date("2026-10-13T17:00:00Z"))).toBe("missed");
 });
 it("requires fresh, complete data for the exact enabled tutor",()=>{
  expect(parseReminderSnapshot(snapshot(),"Buzz",now)).toEqual([candidate]);
  expect(()=>parseReminderSnapshot(snapshot(),"Gift",now)).toThrow();
  expect(()=>parseReminderSnapshot({...snapshot(),syncFinishedAt:"2026-10-13T12:00:00Z"},"Buzz",now)).toThrow();
  expect(()=>parseReminderSnapshot({...snapshot(),candidates:[{...candidate,ownerKey:"Gift"}]},"Buzz",now)).toThrow();
  expect(()=>parseReminderSnapshot({...snapshot(),candidates:[candidate,candidate]},"Buzz",now)).toThrow();
 });
 it("distinguishes changed lessons and dates while retaining harmless fresh timestamps",()=>{
  expect(sameOccurrence(candidate,{...candidate,updatedAt:"2026-10-13T14:41:00Z"})).toBe(true);
  expect(sameOccurrence(candidate,{...candidate,scheduledAt:"2026-10-15T11:00:00Z"})).toBe(false);
  expect(sameOccurrence(candidate,{...candidate,lessonId:"moved"})).toBe(false);
 });
 it("includes the exact course, student, Bangkok test time and preparation steps",()=>{
  const text=reminderText(candidate,"night_before");expect(text).toContain("Student: Student");expect(text).toContain("Course: Maths");expect(text).toContain("18:00");expect(text).toContain("marking guide");expect(text).toContain(candidate.url);
 });
 it("shows the student login email, or says it is not linked",()=>{
  expect(reminderText({...candidate,studentEmail:"ari@example.com"},"night_before")).toContain("Student: Student\nStudent login email: ari@example.com\nCourse: Maths");
  expect(reminderText({...candidate,studentEmail:null},"night_before")).toContain("Student login email: not linked yet. Ask BeGifted.");
  expect(reminderText(candidate,"night_before")).toContain("Student login email: not linked yet. Ask BeGifted.");
 });
 it("accepts old payloads without an email, rejects bad emails and unknown fields, and ignores email changes",()=>{
  expect(parseReminderSnapshot(snapshot(),"Buzz",now)).toHaveLength(1);
  expect(parseReminderSnapshot({...snapshot(),candidates:[{...candidate,studentEmail:null}]},"Buzz",now)[0].studentEmail).toBeNull();
  expect(parseReminderSnapshot({...snapshot(),candidates:[{...candidate,studentEmail:"ari@example.com"}]},"Buzz",now)[0].studentEmail).toBe("ari@example.com");
  expect(()=>parseReminderSnapshot({...snapshot(),candidates:[{...candidate,studentEmail:"not-an-email"}]},"Buzz",now)).toThrow();
  expect(()=>parseReminderSnapshot({...snapshot(),candidates:[{...candidate,extra:"x"}]},"Buzz",now)).toThrow();
  expect(sameOccurrence(candidate,{...candidate,studentEmail:"new@example.com"})).toBe(true);
 });
 it("silently rejects unauthorized setup without reading or writing data",async()=>{
  vi.stubEnv("LINE_SCHEDULE_BOT_ADMIN_IDS","admin");
  const db={select:vi.fn(()=>{throw new Error("Must not read");})};
  expect(await handleProgressGroupCommand({db:db as never,groupId:"group",lineUserId:"intruder",text:"/progress setup Buzz",replyToken:null})).toBe(true);expect(db.select).not.toHaveBeenCalled();
 });
});
