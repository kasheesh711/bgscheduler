import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from '@/lib/db';
import type { SourceWindowResult } from '../../types';
vi.mock('../capture',()=>({captureGrowthBookingMetadata:vi.fn(async()=>({classified:0,unknown:0}))}));
vi.mock('../reconcile',()=>({captureGrowthLifecycle:vi.fn(async()=>{})}));
import { captureGrowthBookingMetadata } from '../capture';
import { captureGrowthLifecycle } from '../reconcile';
import { syncWorkforceHistory } from '../../source-sync';
const directories:string[]=[];
afterEach(()=>{for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});vi.clearAllMocks();});
function setup(){const directory=mkdtempSync(path.join(tmpdir(),'growth-ingestion-'));directories.push(directory);return path.join(directory,'checkpoint.json');}
function source(complete=true):SourceWindowResult{return {sourceKey:'fixture',observedAt:'2026-10-01T00:00:00Z',evidence:{people:[],observations:[],tutorFacts:[],sessions:[],historicalBookedParticipants:[],studentCredits:[],subjectMappings:[],terminationMarks:[],sourceCoverage:[]},requestedWindow:{from:'2026-09-01',to:'2026-09-30'},returnedWindow:{from:null,to:null},paging:{requests:1,pagesRequested:1,pagesReturned:1,recordsReturned:0},truncated:!complete,completeness:complete?'complete':'partial',complete,sessions:[],credits:[],contractIssues:complete?[]:['PAGE_CAP_EXHAUSTED']};}
const request=()=>({from:'2026-09-01',to:'2026-09-30',maxRequests:10,maxPages:10,checkpointPath:setup(),mode:'apply' as const});
describe('growth lifecycle ingestion boundary',()=>{
 it('records lifecycle only after a successful complete source persistence',async()=>{const persist=vi.fn(async()=>{});await syncWorkforceHistory(request(),{db:{} as Database,fetchWindow:async()=>source(),persistWindow:persist});expect(captureGrowthLifecycle).toHaveBeenCalledWith(expect.anything(),new Date('2026-10-01T00:00:00Z'));expect(persist.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(captureGrowthBookingMetadata).mock.invocationCallOrder[0]);expect(vi.mocked(captureGrowthBookingMetadata).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(captureGrowthLifecycle).mock.invocationCallOrder[0]);});
 it('does not record lifecycle for dry runs, incomplete windows, or failed persistence',async()=>{await syncWorkforceHistory({...request(),mode:'dry_run'},{db:{} as Database,fetchWindow:async()=>source()});await syncWorkforceHistory(request(),{db:{} as Database,fetchWindow:async()=>source(false),persistWindow:async()=>{}});await syncWorkforceHistory(request(),{db:{} as Database,fetchWindow:async()=>source(),persistWindow:async()=>{throw new Error('failed persistence');}});expect(captureGrowthLifecycle).not.toHaveBeenCalled();expect(captureGrowthBookingMetadata).not.toHaveBeenCalled();});
});
