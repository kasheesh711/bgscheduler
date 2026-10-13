import {beforeEach,describe,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
vi.mock("@/lib/line/progress-reminders",()=>({sendProgressLineReminders:vi.fn()}));
vi.mock("@/lib/data-health/cron-audit",()=>({withCronInvocationAudit:vi.fn((_input,run)=>run())}));
import {sendProgressLineReminders} from "@/lib/line/progress-reminders";
import {GET} from "../route";
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("CRON_SECRET","test-secret");});
describe("Progress Check reminder cron",()=>{
 it("rejects unsigned requests without starting delivery",async()=>{expect((await GET(new NextRequest("https://app.test/api/internal/progress-line-reminders"))).status).toBe(401);expect(sendProgressLineReminders).not.toHaveBeenCalled();});
 it("returns the send result only for the exact cron bearer",async()=>{vi.mocked(sendProgressLineReminders).mockResolvedValue({sent:1,failed:0});const response=await GET(new NextRequest("https://app.test/api/internal/progress-line-reminders",{headers:{authorization:"Bearer test-secret"}}));expect(response.status).toBe(200);expect(await response.json()).toEqual({sent:1,failed:0});});
});
