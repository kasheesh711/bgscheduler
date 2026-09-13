import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { WorkspaceError } from "../model";
import { requestJson, workspaceError } from "../http";

const mocks = vi.hoisted(() => ({ scope:vi.fn(), file:vi.fn(), blob:vi.fn(), upload:vi.fn(), sync:vi.fn() }));
vi.mock("../access", () => ({ requireWorkspace:mocks.scope }));
vi.mock("../files", () => ({ fileForScope:mocks.file,finalizeUpload:vi.fn(),uploadHandler:mocks.upload }));
vi.mock("@vercel/blob", () => ({ get:mocks.blob }));
vi.mock("@/lib/progress-tests/run-sync-request", () => ({ runProgressTestSyncRequest:mocks.sync }));
vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: (_options:unknown,fn:()=>unknown) => fn() }));
import { GET as download } from "@/app/api/progress-tests/workspace/files/[id]/route";
import { POST as sync } from "@/app/api/progress-tests/workspace/sync/route";
import { POST as callback } from "@/app/api/internal/progress-tests/uploads/route";

const teacher = {keys:["a"],user:{email:"a@example.test",role:"teacher",name:"Tutor A"}};
beforeEach(() => {vi.clearAllMocks();mocks.scope.mockResolvedValue(teacher);});
describe("workspace HTTP boundaries", () => {
  it("authenticates private downloads before touching storage, and resolves access again on the next request", async () => {
    mocks.file.mockResolvedValue({status:"ready",pathname:"progress-tests/fixture/source",mime:"application/pdf",name:"original.pdf"});
    mocks.blob.mockResolvedValue({statusCode:200,blob:{size:9},stream:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("%PDF-test"));controller.close();}})});
    const context={params:Promise.resolve({id:crypto.randomUUID()})};
    const request=new Request("https://example.test/api/progress-tests/workspace/files/test");
    const first=await download(request,context);
    expect(first.status).toBe(200);expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("content-security-policy")).toContain("sandbox");
    expect(await first.text()).toBe("%PDF-test");
    mocks.scope.mockRejectedValueOnce(new WorkspaceError(403,"Access has been revoked."));
    const denied=await download(request,context);
    expect(denied.status).toBe(403);expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.scope).toHaveBeenCalledTimes(2);expect(mocks.blob).toHaveBeenCalledTimes(1);
  });
  it("forbids teacher synchronization and runs it only with a freshly authorized admin", async () => {
    const request=()=>new NextRequest("https://example.test/api/progress-tests/workspace/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    expect((await sync(request())).status).toBe(403);expect(mocks.sync).not.toHaveBeenCalled();
    mocks.scope.mockResolvedValueOnce({keys:null,user:{email:"admin@example.test",role:"admin",name:"Admin"}});
    mocks.sync.mockResolvedValueOnce(Response.json({success:true}));
    expect((await sync(request())).status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith({triggerType:"admin",actorEmail:"admin@example.test"});
    mocks.scope.mockRejectedValueOnce(new WorkspaceError(403,"Access has been revoked."));
    expect((await sync(request())).status).toBe(403);expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
  it("never issues a client upload token through the public callback", async () => {
    const request=new Request("https://example.test/api/internal/progress-tests/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"blob.generate-client-token",payload:{pathname:"forged"}})});
    expect((await callback(request)).status).toBe(401);expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("rejects cross-origin commands and limits UTF-8 bytes, while keeping error responses private", async () => {
    await expect(requestJson(new Request("https://example.test/api/progress-tests/workspace",{method:"POST",headers:{origin:"https://unrelated.test"},body:"{}"}))).rejects.toMatchObject({status:403});
    await expect(requestJson(new Request("https://example.test/api/progress-tests/workspace",{method:"POST",body:JSON.stringify({text:"ก".repeat(1_200_000)})}))).rejects.toMatchObject({status:413});
    expect(workspaceError(new Error("Unauthorized")).status).toBe(401);
    expect(workspaceError(new Error("Unauthorized")).headers.get("cache-control")).toBe("private, no-store");
  });
});
