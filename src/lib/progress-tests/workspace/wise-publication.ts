import { createHash } from "node:crypto";
import { WiseClient } from "@/lib/wise/client";
import { MAX_FILE_BYTES, WorkspaceError } from "./model";

export const SECTION_NAME = "Progress Tests";
const objectId = /^[a-f0-9]{24}$/i;
export type WiseResource = { _id: string; name: string; type: string; classId: string; file?: { _id: string; path: string; size: number; type: string } };
export type WiseSection = { _id: string; name: string; enabled: boolean; entities: WiseResource[]; children?: WiseSection[] };
export interface NativeWise {
  verifyCourse(classId: string, studentId: string): Promise<void>;
  timeline(classId: string): Promise<WiseSection[]>;
  createSection(classId: string): Promise<string>;
  upload(name: string, bytes: Buffer): Promise<string>;
  attach(classId: string, sectionId: string, name: string, token: string): Promise<void>;
  remove(classId: string, sectionId: string, resourceId: string): Promise<void>;
  verifyFile(resource: WiseResource, hash: string): Promise<void>;
}
export function validateCourse(data: Record<string, unknown>, classId: string, studentId: string) {
  const ids = (value: unknown) => Array.isArray(value) ? value.map(v => typeof v === "string" ? v : v?._id) : [];
  const students = ids(data.joinedRequest);
  const settings = data.settings as Record<string, unknown> | undefined;
  if (data._id !== classId || data.classType !== "ONE_TO_ONE" || data.archived !== false || data.hidden !== false ||
      students.length !== 1 || students[0] !== studentId || ids(data.suspendedStudents).includes(studentId) ||
      !settings || settings.openClassroom !== false || settings.lockClassroom !== false || Number(settings.lockAfter) > 0 || Number(settings.validityInDays) > 0)
    throw new WorkspaceError(422, "The Wise course or its student access needs administrator review. Results have not been shared.");
}
export function safeWiseUrl(raw: string, type: "upload" | "file") {
  const url = new URL(raw);
  const allowed = type === "upload" ? ["wise-app-s3-bucket.s3.ap-south-1.amazonaws.com"] : ["files.wiseapp.live"];
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed.includes(url.hostname)) throw new WorkspaceError(422, "Wise returned an unrecognized file destination. Administrator review is required.");
  return url;
}
export function fileHash(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
async function boundedBytes(response: Response) {
  if (!response.ok || !response.body) throw new Error("Native file readback failed");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > MAX_FILE_BYTES) throw new WorkspaceError(422,"Wise file is larger than the approved PDF."); chunks.push(r.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
export function nativeWise(guard: () => Promise<void>, signal = AbortSignal.timeout(180_000)): NativeWise {
  // Non-idempotent POSTs must never be retried by the generic HTTP client.
  const client = new WiseClient({ userId:process.env.WISE_USER_ID!,apiKey:process.env.WISE_API_KEY!,namespace:process.env.WISE_NAMESPACE ?? "begifted-education",maxRetries:0,maxConcurrency:1,requestsPerSecond:3,signal,beforeRequest:guard });
  const checkedId = (id: string) => { if (!objectId.test(id)) throw new WorkspaceError(422,"Wise destination identifier needs review."); return id; };
  return {
    async verifyCourse(classId,studentId) {
      const r = await client.get<{data:Record<string,unknown>}>(`/user/v2/classes/${checkedId(classId)}`,{full:"true"},{cache:"no-store"});
      validateCourse(r.data,classId,checkedId(studentId));
    },
    async timeline(classId) {
      const r = await client.get<{data:{timeline:WiseSection[];dripSettings:string;sequentialLearning:boolean}}>(`/user/classes/${checkedId(classId)}/contentTimeline`,{showSequentialLearningDisabledSections:"true"},{cache:"no-store"});
      if (!Array.isArray(r.data?.timeline) || r.data.dripSettings !== "OFF" || r.data.sequentialLearning !== false) throw new WorkspaceError(422,"Wise Content has restricted or unrecognized visibility settings. An administrator must review this course.");
      return r.data.timeline;
    },
    async createSection(classId) {
      const r = await client.post<{data:{section:{_id:string}}}>(`/teacher/classes/${checkedId(classId)}/sections`,{name:SECTION_NAME});
      return checkedId(r.data?.section?._id);
    },
    async upload(name,bytes) {
      const r = await client.get<{data:{uploadURL:string;uploadToken:string}}>("/user/uploadURL",{filename:name,type:"application/pdf",size:String(bytes.length)},{cache:"no-store"});
      if (!r.data?.uploadToken) throw new Error("Missing native upload authorization");
      await guard();
      const put = await fetch(safeWiseUrl(r.data.uploadURL,"upload"),{method:"PUT",body:new Uint8Array(bytes),headers:{"Content-Type":"application/pdf"},redirect:"error",signal});
      if (!put.ok) throw new Error("Native binary upload failed");
      return r.data.uploadToken;
    },
    async attach(classId,sectionId,name,token) {
      await client.post("/teacher/createResourceInBulk",{classId:checkedId(classId),sectionId:checkedId(sectionId),resources:[{name,uploadTokens:[token],type:"file"}]});
    },
    async remove(classId, sectionId, resourceId) {
      await client.post("/teacher/deleteResourceInBulk/", { classId: checkedId(classId), sectionId: checkedId(sectionId), entityType: "resource", resourceIds: [checkedId(resourceId)] });
    },
    async verifyFile(resource,hash) {
      if (!resource.file?._id || resource.type !== "file" || resource.file.type !== "pdf") throw new WorkspaceError(422,"Wise attachment does not match the approved PDF.");
      await guard();
      const bytes = await boundedBytes(await fetch(safeWiseUrl(resource.file.path,"file"),{redirect:"error",cache:"no-store",signal}));
      if (fileHash(bytes) !== hash) throw new WorkspaceError(422,"Wise attachment bytes differ from the approved PDF. Administrator review is required.");
    },
  };
}
