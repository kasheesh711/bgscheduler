import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { getGuide,saveGuide,guideCommand } from "@/lib/progress-tests/workspace/guide";
import { privateJson,requestJson,workspaceError } from "@/lib/progress-tests/workspace/http";
export async function GET(){try{return privateJson(await getGuide(await requireWorkspace()));}catch(error){return workspaceError(error);}}
export async function PATCH(request:Request){try{const scope=await requireWorkspace();return privateJson(await saveGuide(scope,guideCommand.parse(await requestJson(request))));}catch(error){return workspaceError(error);}}
