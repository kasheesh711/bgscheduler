import {beforeEach, describe, expect, it, vi} from "vitest";
const mocks=vi.hoisted(()=>({load:vi.fn(),launch:vi.fn(),client:vi.fn(),db:{}}));
vi.mock("@/lib/db",()=>({getDb:()=>mocks.db}));
vi.mock("@/lib/progress-tests/workspace/attendance",()=>({loadWorkspaceAttendance:mocks.load}));
vi.mock("@/lib/progress-tests/workspace/cutover",()=>({launchConfig:mocks.launch}));
vi.mock("@/lib/wise/client",()=>({createWiseClient:mocks.client}));
vi.mock("@/lib/progress-tests/transfer/control",()=>({sourceTransferControl:vi.fn(),MovedWorkflowError:class extends Error{}}));
vi.mock("@/lib/progress-tests/db",()=>({loadActiveIdentityEntries:vi.fn()}));
vi.mock("@/lib/progress-tests/workspace/files",()=>({readBlobBytes:vi.fn()}));
import {GET} from "../route";
describe("private attendance export",()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("PROGRESS_EXPORT_SECRET","s".repeat(40));vi.stubEnv("WISE_INSTITUTE_ID","pilot");mocks.launch.mockResolvedValue({activatedAt:new Date("2026-09-13T00:00:00Z")});mocks.client.mockReturnValue({});mocks.load.mockResolvedValue({source:[],packages:[],snapshotId:null});});
 it("denies requests before it reads attendance",async()=>{expect((await GET(new Request("https://source.test/api/integrations/progress-export?type=attendance"))).status).toBe(401);expect(mocks.load).not.toHaveBeenCalled();});
 it("uses the saved launch and returns fresh bounded evidence",async()=>{
  const result=await GET(new Request("https://source.test/api/integrations/progress-export?type=attendance",{headers:{authorization:`Bearer ${"s".repeat(40)}`}}));
  expect(result.status).toBe(200);expect(result.headers.get("cache-control")).toBe("private, no-store");expect(await result.json()).toMatchObject({schemaVersion:1,launchedAt:"2026-09-13T00:00:00.000Z",source:[],packages:[]});expect(mocks.load.mock.calls[0][3]).toEqual(new Date("2026-09-13T00:00:00Z"));
 });
 it("does not return a partial successful export on reader failure",async()=>{mocks.load.mockRejectedValue(new Error("provider detail"));const result=await GET(new Request("https://source.test/api/integrations/progress-export?type=attendance",{headers:{authorization:`Bearer ${"s".repeat(40)}`}}));expect(result.status).toBe(500);expect(await result.text()).not.toContain("provider detail");});
});
