import { createHash } from "node:crypto";
export function canonical(value:unknown):string {
 if(value instanceof Date)return JSON.stringify(value.toISOString());
 if(typeof value==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))return JSON.stringify(new Date(value).toISOString());
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export function rowHash(rows:unknown[]) { return createHash("sha256").update(rows.map(canonical).sort().join('\n')).digest("hex"); }
