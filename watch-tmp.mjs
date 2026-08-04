import fs from "node:fs"; import pg from "pg";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const c=new pg.Client({connectionString:env.DATABASE_URL}); await c.connect();
for (let i=0;i<24;i++){
  const r=(await c.query(`SELECT status, started_at, finished_at, session_count, error_summary
    FROM credit_control_sync_runs ORDER BY started_at DESC LIMIT 1`)).rows[0];
  if (r.status!=="running"){
    console.log(`RUN ${r.status.toUpperCase()} started=${String(r.started_at).slice(4,24)} sessions=${r.session_count}`);
    if (r.error_summary) console.log("error_summary:", JSON.stringify(r.error_summary).slice(0,300));
    const t=(await c.query(`SELECT count(*) FILTER (WHERE teacher_name IS NOT NULL) named, count(*) total
      FROM credit_control_sessions WHERE snapshot_id=(SELECT id FROM credit_control_snapshots WHERE active LIMIT 1)`)).rows[0];
    console.log(`teacher coverage on active snapshot: ${t.named}/${t.total}`);
    const s=(await c.query(`SELECT teacher_name, subject, count(*) n FROM credit_control_sessions
      WHERE snapshot_id=(SELECT id FROM credit_control_snapshots WHERE active LIMIT 1)
        AND teacher_name IS NOT NULL GROUP BY 1,2 ORDER BY n DESC LIMIT 5`)).rows;
    if (s.length) console.table(s);
    break;
  }
  await new Promise(r=>setTimeout(r,30000));
}
await c.end();
