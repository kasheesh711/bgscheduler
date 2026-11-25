import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { hiringAssessmentFiles as files, hiringBookings as bookings, hiringCandidates as candidates, hiringRecruitmentDeliveries as deliveries, tutorContacts } from "@/lib/db/schema";
import { HiringError, localDate, runtimeWritesAllowed, shiftDate, ZONE } from "./model";
import { enqueueRecruitmentLine } from "./recruitment";
import { settings } from "./service";

/** One printed paper test: a cover page, then the subject's question paper. */
export type PrintItem = {
  candidateId: string;
  name: string;
  subject: string;
  start: Date;
  end: Date;
  /** The head of the visit's mock, as a nickname ("Gift"). */
  head: string | null;
  mockAt: Date | null;
  /** The active question paper of the subject, or null when the library has none. */
  fileId: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const nick = (name: string) => /\(([^)]+)\)/.exec(name)?.[1] ?? name;
const dayStart = (date: string) => new Date(`${date}T00:00:00+07:00`);

// The print link is its own token: a booking token cannot open it, and it cannot open a booking (both parse strictly).
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(`print:${payload}`).digest();

/** A link for the paper tests of one Bangkok day, or of one candidate on that day. It ends when the day ends. */
export function printToken(date: string, candidateId: string | null = null, secret = process.env.AUTH_SECRET) {
  if (!secret) throw new HiringError(503, "Print links are not configured.");
  if (!DATE.test(date)) throw new HiringError(400, "Choose a date.");
  const exp = Math.floor(dayStart(shiftDate(date, 1)).getTime() / 1000);
  const payload = Buffer.from(JSON.stringify(candidateId ? { date, candidateId, exp } : { date, exp })).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export function readPrintToken(token: string, now = new Date(), secret = process.env.AUTH_SECRET) {
  try {
    if (!secret || token.length > 400) throw new Error();
    const [payload, signature, extra] = token.split(".");
    const expected = sign(payload, secret);
    const actual = Buffer.from(signature ?? "", "base64url");
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const value = z.object({ date: z.string().regex(DATE), candidateId: z.uuid().optional(), exp: z.number().int() }).strict()
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (value.exp <= now.getTime() / 1000) throw new Error();
    return { date: value.date, candidateId: value.candidateId ?? null };
  } catch {
    throw new HiringError(404, "This print link is invalid or has expired. Open a new one from the Hiring page.");
  }
}

export const printPackUrl = (date: string, candidateId: string | null = null) =>
  new URL(`/hiring/print/${printToken(date, candidateId)}`, process.env.APP_BASE_URL || "https://bgscheduler.vercel.app").toString();

/**
 * The paper tests of the day that have not started yet, in time order. Cancelled and no-show tests are left out,
 * as on the Hiring page's Coming up list.
 */
export async function printItems(db: Database, date: string, candidateId: string | null = null, now = new Date()): Promise<PrintItem[]> {
  const start = dayStart(date);
  const end = dayStart(shiftDate(date, 1));
  const rows = await db.select({ booking: bookings, name: candidates.name }).from(bookings)
    .innerJoin(candidates, eq(bookings.candidateId, candidates.id))
    .where(and(eq(bookings.kind, "paper"), notInArray(bookings.status, ["cancelled", "no_show"]),
      gte(bookings.startTime, start), lt(bookings.startTime, end), sql`${bookings.startTime} > ${now.toISOString()}::timestamptz`,
      candidateId ? eq(bookings.candidateId, candidateId) : undefined))
    .orderBy(asc(bookings.startTime), asc(candidates.name));
  if (!rows.length) return [];
  const visits = rows.map((r) => r.booking.visitId).filter((id): id is string => !!id);
  const mocks = visits.length ? await db.select().from(bookings)
    .where(and(eq(bookings.kind, "mock"), inArray(bookings.visitId, visits), notInArray(bookings.status, ["cancelled"]))) : [];
  const subjects = [...new Set(rows.map((r) => r.booking.subjects[0]).filter(Boolean))];
  const papers = await db.select({ id: files.id, subject: files.subject }).from(files)
    .where(and(eq(files.kind, "question_paper"), eq(files.active, true), eq(files.status, "ready"), inArray(files.subject, subjects)));
  const keys = [...new Set(mocks.map((m) => m.interviewerKey).filter((k): k is string => !!k))];
  const contacts = keys.length ? await db.select({ key: tutorContacts.canonicalKey, name: tutorContacts.displayName }).from(tutorContacts)
    .where(inArray(tutorContacts.canonicalKey, keys)) : [];
  return rows.map(({ booking: b, name }) => {
    const mock = b.visitId ? mocks.find((m) => m.visitId === b.visitId) : undefined;
    const key = b.interviewerKey ?? mock?.interviewerKey ?? null;
    const head = key ? contacts.find((c) => c.key === key)?.name ?? key : null;
    const subject = b.subjects[0] ?? "";
    return { candidateId: b.candidateId, name, subject, start: b.startTime, end: b.endTime, head: head && nick(head),
      mockAt: mock?.startTime ?? null, fileId: papers.find((p) => p.subject === subject)?.id ?? null };
  });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hm = (d: Date) => formatInTimeZone(d, ZONE, "HH:mm");

let assets: Record<"logo" | "manrope500" | "manrope600" | "manropeExt" | "plex" | "thai", string> | undefined;
function coverAssets() {
  const file = (path: string, type: string) => `data:${type};base64,${readFileSync(join(process.cwd(), path)).toString("base64")}`;
  const dir = "public/brand/hiring-print";
  assets ??= {
    logo: file("public/brand/logo-horizontal.png", "image/png"),
    manrope500: file(`${dir}/manrope-latin-500-normal.woff2`, "font/woff2"),
    manrope600: file(`${dir}/manrope-latin-600-normal.woff2`, "font/woff2"),
    manropeExt: file(`${dir}/manrope-latin-ext-500-normal.woff2`, "font/woff2"),
    plex: file(`${dir}/ibm-plex-mono-latin-400-normal.woff2`, "font/woff2"),
    // Manrope has no Thai; a Thai name falls back to Sarabun.
    thai: file("node_modules/@fontsource/sarabun/files/sarabun-thai-400-normal.woff2", "font/woff2"),
  };
  return assets;
}

/** One A4 cover page for each item, in the BeGifted Porcelain look. */
export function coversHtml(items: PrintItem[]) {
  const a = coverAssets();
  const pages = items.map((item) => {
    const [first, ...rest] = item.name.trim().split(/\s+/);
    const rows: [string, string][] = [
      ["Subject", item.subject || "Not recorded"],
      ["Date", formatInTimeZone(item.start, ZONE, "EEEE d MMMM yyyy")],
      ["Exam time", `${hm(item.start)}–${hm(item.end)}`],
      ...(item.mockAt ? [["Mock teaching", `${hm(item.mockAt)}${item.head ? ` with ${item.head}` : ""}`] as [string, string]] : []),
    ];
    return `<section class="page">
<header><img src="${a.logo}" alt="BeGifted Education"><span class="label">Teacher assessment</span></header>
<div class="lead"><p class="eyebrow"><i></i>Paper test</p>
<h1><em>${escape(first ?? "")}</em>${rest.length ? ` ${escape(rest.join(" "))}` : ""}</h1></div>
<dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(v)}</dd></div>`).join("")}</dl>
<footer><p class="label">For staff</p><div class="sign"><span>Started</span><span>Finished</span><span>Collected by</span></div></footer>
</section>`;
  });
  return `<!doctype html><html lang="en" data-begifted-look="porcelain"><head><meta charset="utf-8"><title>Paper test covers</title><style>
@font-face{font-family:Manrope;src:url('${a.manrope500}') format('woff2');font-weight:500;unicode-range:U+0000-00FF,U+2000-206F}
@font-face{font-family:Manrope;src:url('${a.manropeExt}') format('woff2');font-weight:500;unicode-range:U+0100-02FF,U+1E00-1EFF}
@font-face{font-family:Manrope;src:url('${a.manrope600}') format('woff2');font-weight:600;unicode-range:U+0000-00FF,U+2000-206F}
@font-face{font-family:Plex;src:url('${a.plex}') format('woff2');font-weight:400}
@font-face{font-family:Sarabun;src:url('${a.thai}') format('woff2');font-weight:400;unicode-range:U+0E00-0E7F}
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html{font-family:Manrope,Sarabun,Arial,sans-serif;color:#202733;font-variant-numeric:tabular-nums;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;height:297mm;padding:22mm 22mm 24mm;display:flex;flex-direction:column;break-after:page;background:#fff}
.page:last-child{break-after:auto}
header{display:flex;justify-content:space-between;align-items:center;padding-bottom:7mm;border-bottom:1px solid #CBD1DC}
header img{width:44mm;height:auto}
.label{font-family:Plex,monospace;font-size:9pt;color:#596372}
.lead{margin-top:46mm}
.eyebrow{display:flex;align-items:center;gap:3mm;font-family:Plex,monospace;font-size:9pt;letter-spacing:.12em;text-transform:uppercase;color:#596372}
.eyebrow i{width:6px;height:6px;border-radius:50%;background:#2545A5}
h1{margin-top:7mm;font-size:46pt;font-weight:500;line-height:1.04;letter-spacing:-.015em;text-wrap:balance;overflow-wrap:anywhere}
h1 em{font-style:normal}
dl{margin-top:18mm;border-top:1.5px solid #2545A5}
dl div{display:grid;grid-template-columns:42mm 1fr;align-items:baseline;padding:5mm 0;border-bottom:1px solid #CBD1DC}
dt{font-family:Plex,monospace;font-size:9.5pt;color:#596372}
dd{font-size:17pt;font-weight:500;line-height:1.3}
footer{margin-top:auto}
.sign{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm;margin-top:5mm}
.sign span{margin-top:12mm;padding-top:2mm;border-top:1px solid #202733;font-size:9.5pt;color:#596372}
</style></head><body>${pages.join("")}</body></html>`;
}

/** The cover pages as one PDF, drawn by the shared server Chromium. */
export async function renderCovers(items: PrintItem[]) {
  const { launchPdfBrowser } = await import("@/lib/onsite-foot-traffic/pdf");
  const browser = await launchPdfBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(coversHtml(items), { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * The morning print message in the recruitment group: today's paper tests and one link to print them all.
 * `{person}` is replaced at sending by a LINE tag of the person saved with "@Thea print setup" (deliverRecruitment).
 */
export async function queuePrintPack(db: Database, now = new Date()) {
  if (!runtimeWritesAllowed()) return false;
  const date = localDate(now);
  const minute = (now.getTime() - dayStart(date).getTime()) / 60000;
  // The cron fires at 08:29 Bangkok; later hiring delivery ticks retry a missed send until 09:50.
  if (minute < 8 * 60 + 29 || minute >= 9 * 60 + 50) return false;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-print-pack'))`);
    const { config } = await settings(tx);
    if (!config.enabled || !config.deliveryEnabled || !config.recruitmentLineGroupId) return false;
    const key = `print-pack:${date}`;
    const [exists] = await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.key, `${key}:0000`));
    if (exists) return false;
    const items = await printItems(tx, date, null, now);
    if (!items.length) return false;
    const lines = items.map((i) => `${hm(i.start)} ${i.name} · ${i.subject}${i.fileId ? "" : " (no paper in the library)"}`);
    await enqueueRecruitmentLine(tx, key, config.recruitmentLineGroupId,
      `{person} 🖨️ Papers to print today (${items.length})\n${lines.join("\n")}\n\nAll covers and papers in one file:\n${printPackUrl(date)}`, null, "print-pack");
    return true;
  });
}
