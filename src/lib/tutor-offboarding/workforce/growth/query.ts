import { z } from "zod";
import { TutorOffboardingError } from "../../errors";
import { parseWorkforceQuery } from "../query";
import type { GrowthDetailQuery, GrowthExportSection, GrowthQuery } from "./types";

const hours = z.number().finite().min(0).max(1e8);
const override = z.object({
  newStudentHours: hours.optional(), reactivatedStudentHours: hours.optional(), churnStudentHours: hours.optional(),
  cancellationFraction:z.number().finite().min(0).max(1).optional(),
  studentHoursPerTutorHour:z.number().finite().positive().max(1e5).optional(),
}).strict();
const assumptions = z.object({
  bufferPercent:z.number().finite().min(0).max(100).default(0),
  subjects:z.record(z.string().min(1).max(500),override).refine(v=>Object.keys(v).length<=100,"At most100 course overrides are allowed.").optional(),
}).strict().default({bufferPercent:0});
const base = z.object({filters:z.record(z.string(),z.string()),assumptions}).strict();
const revision = z.string().min(1).max(200);
const detail = base.extend({
  reportRevision:revision, kind:z.enum(["cohort","churn","cancellation","capacity"]),
  key:z.string().min(1).max(1000), cursor:z.string().min(1).max(1000).optional(),
  pageSize:z.number().int().min(1).max(500).default(100),
}).strict();
const exporting = base.extend({reportRevision:revision,section:z.enum(["months","averages","forecast","gaps"])}).strict();

function validateKeys(value: unknown, depth=0): void {
  if (depth>8) throw new TutorOffboardingError("The scenario nesting is invalid.",400);
  if (!value || typeof value!=="object") return;
  for(const [key,child] of Object.entries(value)) {
    if(["__proto__","constructor","prototype"].includes(key)) throw new TutorOffboardingError("The scenario has an invalid field.",400);
    validateKeys(child,depth+1);
  }
}
export function parseGrowthRequest(value: unknown): GrowthQuery {
  validateKeys(value);
  const parsed=base.parse(value);
  return {filters:parseWorkforceQuery(new URLSearchParams(parsed.filters)),assumptions:parsed.assumptions};
}
export function parseGrowthGetQuery(params: URLSearchParams): GrowthQuery {
  return {filters:parseWorkforceQuery(params),assumptions:{bufferPercent:0}};
}
export function parseGrowthDetailRequest(value: unknown): GrowthDetailQuery {
  validateKeys(value);
  const {filters,assumptions,...selection}=detail.parse(value);
  return {...parseGrowthRequest({filters,assumptions}),...selection};
}
export function parseGrowthExportRequest(value: unknown): {query:GrowthQuery;reportRevision:string;section:GrowthExportSection} {
  validateKeys(value);
  const {filters,assumptions,reportRevision,section}=exporting.parse(value);
  return {query:parseGrowthRequest({filters,assumptions}),reportRevision,section};
}
export async function readGrowthBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new TutorOffboardingError("Send the scenario as JSON.",400);
  const limit=65536;
  if (Number(request.headers.get("content-length"))>limit) throw new TutorOffboardingError("The scenario must be at most64 KiB.",400);
  const reader=request.body?.getReader();
  if(!reader) throw new TutorOffboardingError("The scenario body is missing.",400);
  const decoder=new TextDecoder("utf-8",{fatal:true}); let body="",length=0;
  try {
    while(true) {
      const next=await reader.read(); if(next.done) break;
      length+=next.value.byteLength;
      if(length>limit) {await reader.cancel();throw new TutorOffboardingError("The scenario must be at most64 KiB.",400);}
      body+=decoder.decode(next.value,{stream:true});
    }
    body+=decoder.decode();
    return JSON.parse(body);
  } catch(error) {
    if(error instanceof TutorOffboardingError) throw error;
    throw new TutorOffboardingError("The scenario must contain valid JSON.",400);
  } finally {reader.releaseLock();}
}
