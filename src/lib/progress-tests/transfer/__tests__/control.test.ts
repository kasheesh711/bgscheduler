import {describe,it,expect} from "vitest";
import {assertSourcePhase,MovedWorkflowError} from "../control";
import {workspaceError} from "../../workspace/http";
describe("single source writer",()=>{
 it("permits only the source phase",()=>{expect(()=>assertSourcePhase("source")).not.toThrow();for(const phase of ["paused","moved"] as const)expect(()=>assertSourcePhase(phase,"https://bank.test/#/progress")).toThrow(MovedWorkflowError);});
 it("keeps the moved address in its private API response",async()=>{const response=workspaceError(new MovedWorkflowError("https://bank.test/#/progress"));expect(response.status).toBe(410);expect(await response.json()).toMatchObject({code:"workflow_moved",url:"https://bank.test/#/progress"});expect(response.headers.get("cache-control")).toBe("private, no-store");});
});
