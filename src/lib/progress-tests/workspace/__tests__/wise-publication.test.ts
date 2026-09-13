import {describe,it,expect,vi,afterEach} from "vitest";
import {validateCourse,safeWiseUrl,nativeWise,fileHash} from "../wise-publication";
const course={_id:"a".repeat(24),classType:"ONE_TO_ONE",archived:false,hidden:false,joinedRequest:["b".repeat(24)],suspendedStudents:[],settings:{openClassroom:false,lockClassroom:false,lockAfter:0,validityInDays:-1}};
afterEach(()=>vi.unstubAllGlobals());
describe("verified native Wise boundary",()=>{
 it("accepts only the exact private one-to-one student destination",()=>{
  expect(()=>validateCourse(course,course._id,course.joinedRequest[0])).not.toThrow();
  for(const patch of [{classType:"REGULAR"},{archived:true},{joinedRequest:["other"]},{joinedRequest:[...course.joinedRequest,"other"]},{suspendedStudents:course.joinedRequest},{settings:{...course.settings,openClassroom:true}},{settings:{...course.settings,lockClassroom:true}}])expect(()=>validateCourse({...course,...patch},course._id,course.joinedRequest[0])).toThrow();
 });
 it("does not transmit credentials to arbitrary file hosts or redirects",()=>{
  expect(safeWiseUrl("https://files.wiseapp.live/a.pdf","file").hostname).toBe("files.wiseapp.live");
  for(const url of ["http://files.wiseapp.live/a","https://files.wiseapp.live.attacker.test/a","https://user:pass@files.wiseapp.live/a","https://127.0.0.1/a"])expect(()=>safeWiseUrl(url,"file")).toThrow();
 });
 it("uploads raw bytes without Wise authentication and does not retry uncertain attachment POSTs",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:{uploadURL:"https://wise-app-s3-bucket.s3.ap-south-1.amazonaws.com/test",uploadToken:"private"}}))).mockResolvedValueOnce(new Response(null,{status:200})).mockRejectedValueOnce(new Error("network"));
  vi.stubGlobal("fetch",fetch);const wise=nativeWise(async()=>{});
  const token=await wise.upload("test.pdf",Buffer.from("pdf"));expect(token).toBe("private");
  expect(fetch.mock.calls[1][1].headers).toEqual({"Content-Type":"application/pdf"});expect(fetch.mock.calls[1][1].redirect).toBe("error");
  await expect(wise.attach(course._id,"c".repeat(24),"test.pdf",token)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(3);
 });
 it("rejects a byte mismatch on native readback",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("changed")));
  await expect(nativeWise(async()=>{}).verifyFile({_id:"r",name:"x.pdf",classId:course._id,type:"file",file:{_id:"f",path:"https://files.wiseapp.live/x.pdf",size:7,type:"pdf"}},fileHash(Buffer.from("approved")))).rejects.toMatchObject({status:422});
 });
});
