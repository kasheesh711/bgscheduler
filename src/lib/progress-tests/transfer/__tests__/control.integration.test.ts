import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {sql} from "drizzle-orm";
import type {Database} from "@/lib/db";
import {withSourceWriter} from "../control";
let pool:pg.Pool;
const parent=process.env.PROGRESS_TEST_DATABASE_URL||"postgresql://kevinhsieh@127.0.0.1:54339/postgres";
const url=new URL(parent),name=`progress_source_control_${randomUUID().replaceAll('-','')}`;
if(!["localhost","127.0.0.1"].includes(url.hostname))throw new Error("Use a local synthetic database for the control test.");
url.pathname=`/${name}`;
beforeAll(async()=>{const root=new pg.Client({connectionString:parent});await root.connect();await root.query(`create database "${name}"`);await root.end();pool=new pg.Pool({connectionString:url.toString()});await pool.query("create table progress_transfer_control(id text primary key,phase text,target_url text);insert into progress_transfer_control values('writer','source',null);create table receipts(id text primary key)");});
afterAll(async()=>{if(pool)await pool.end();});
describe("source mail pause transaction",()=>{
 it("keeps the send receipt before a pause and stops the next send",async()=>{
  const db=drizzle(pool) as unknown as Database,pauseClient=await pool.connect();
  let entered!:()=>void,release!:()=>void;const sending=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
  const first=withSourceWriter(db,async tx=>{entered();await hold;await tx.execute(sql`insert into receipts values('accepted-first-send')`);});
  try {
   await sending;let pauseDone=false;
   const pause=pauseClient.query("update progress_transfer_control set phase='paused' where id='writer'").then(()=>{pauseDone=true;});
   await new Promise(r=>setTimeout(r,60));expect(pauseDone).toBe(false);
   release();await first;await pause;
   const nextSend=vi.fn();await expect(withSourceWriter(db,nextSend)).rejects.toMatchObject({status:503});expect(nextSend).not.toHaveBeenCalled();
   expect((await pool.query("select id from receipts")).rows).toEqual([{id:"accepted-first-send"}]);
  }finally{release();await first;pauseClient.release();}
 });
 it("blocks a send if the transfer table has no writer record",async()=>{
  await pool.query("delete from progress_transfer_control where id='writer'");const send=vi.fn();await expect(withSourceWriter(drizzle(pool) as unknown as Database,send)).rejects.toMatchObject({status:503});expect(send).not.toHaveBeenCalled();
 });

});
