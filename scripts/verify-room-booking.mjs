// Local-only browser verification. Use a migrated, disposable test database.
import { chromium } from "playwright-core";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const database = process.env.TEST_DATABASE_URL;
if (!database) throw new Error("TEST_DATABASE_URL is required");
const parsed = new URL(database);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  !parsed.pathname.endsWith("_test")
)
  throw new Error("Use only an isolated local database ending in _test");
const pool = new pg.Pool({ connectionString: database });
const origin = process.env.ROOM_TEST_ORIGIN ?? "http://localhost:3311";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("Use a local app server");
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
  .format(new Date())
  .split(":")
  .map(Number);
const nowMinute = parts[0] * 60 + parts[1],
  start = Math.max(420, Math.ceil((nowMinute + 1) / 15) * 15),
  end = start + 30;
if (end > 1260)
  throw new Error("Run the booking smoke test before 20:15 Bangkok");
const fmt = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const user = `room-browser-${randomUUID()}`,
  token = randomBytes(32).toString("base64url"),
  hash = createHash("sha256").update(token).digest("hex");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const failures = [];
try {
  const active = await pool.query(
    "SELECT id FROM snapshots WHERE active = true LIMIT 1",
  );
  const snapshot =
    active.rows[0]?.id ??
    (
      await pool.query(
        "INSERT INTO snapshots(active) VALUES(true) RETURNING id",
      )
    ).rows[0].id;
  await pool.query(
    "INSERT INTO tutor_identity_groups(snapshot_id,canonical_key,display_name) VALUES($1,$2,'Room Test Tutor')",
    [snapshot, user],
  );
  await pool.query(
    "INSERT INTO room_tutor_links(line_user_id,canonical_key,display_name,status) VALUES($1,$1,'Room Test Tutor','approved')",
    [user],
  );
  await pool.query(
    "INSERT INTO classroom_rooms(name,capacity,active) VALUES('Focus',2,true) ON CONFLICT(name) DO UPDATE SET active=true",
  );
  const evidence = {
    blocks: [
      {
        sessionId: "browser-class",
        classId: "browser-class-id",
        canonicalKey: user,
        startMinute: 420,
        endMinute: 480,
        room: "Focus",
        remote: false,
        blocking: false,
        status: "COMPLETED",
      },
    ],
    uncertain: [],
  };
  await pool.query(
    "INSERT INTO room_day_states(date,checked_at,evidence) VALUES($1,now(),$2) ON CONFLICT(date) DO UPDATE SET checked_at=now(),evidence=$2,lease_owner=null,lease_until=null,revision=room_day_states.revision+1",
    [today, evidence],
  );
  await pool.query(
    "INSERT INTO room_access_grants(token_hash,line_user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [hash, user],
  );
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => failures.push(e.message));
  await page.goto(`${origin}/room/${token}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: "/tmp/room-browser-initial.png",
    fullPage: true,
  });
  await writeFile(
    "/tmp/room-browser-initial.txt",
    await page.locator("body").innerText(),
  );
  await page.getByRole("heading", { name: "A room for your day" }).waitFor();
  await page.getByRole("checkbox", { name: "Start now" }).uncheck();
  await page.getByLabel("From", { exact: true }).fill(fmt(start));
  await page.getByLabel("Until", { exact: true }).fill(fmt(end));
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Focus", exact: true }) });
  await card.getByRole("button", { name: "Book room" }).click();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await page.getByRole("heading", { name: "My reservations" }).waitFor();
  await page.getByRole("button", { name: "Cancel reservation" }).click();
  await page.getByText("Cancelled by you.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "My day", exact: true }).click();
  await page.getByRole("heading", { name: "Today’s classes" }).waitFor();
  await page
    .getByRole("button", { name: "Available rooms", exact: true })
    .click();
  await mkdir("/tmp/room-browser-artifacts", { recursive: true });
  await page.screenshot({
    path: "/tmp/room-browser-artifacts/mobile-light.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: "/tmp/room-browser-artifacts/mobile-dark.png",
    animations: "disabled",
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw new Error("Mobile content overflows horizontally");
  await card.getByRole("button", { name: "Book room" }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({
    path: "/tmp/room-browser-artifacts/confirmation-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/room-browser-artifacts/desktop-dark.png",
    animations: "disabled",
    fullPage: true,
  });
  const unauthenticated = await page.request.get(
    `${origin}/api/room/availability`,
  );
  if (unauthenticated.status() !== 401)
    throw new Error(`Unauthenticated API returned ${unauthenticated.status()}`);
  await pool.query(
    "UPDATE room_access_grants SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
    [hash],
  );
  await page.reload();
  await page.getByRole("heading", { name: "Open a new room link" }).waitFor();
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    "PASS: mobile booking, confirmation, cancellation, personal schedule, light/dark rendering, overflow, API auth, expired link",
  );
} finally {
  await browser.close();
  await pool.query("DELETE FROM room_notifications WHERE line_user_id=$1", [
    user,
  ]);
  await pool.query("DELETE FROM room_reservations WHERE line_user_id=$1", [
    user,
  ]);
  await pool.query("DELETE FROM room_access_grants WHERE line_user_id=$1", [
    user,
  ]);
  await pool.query("DELETE FROM room_tutor_links WHERE line_user_id=$1", [
    user,
  ]);
  await pool.query("DELETE FROM tutor_identity_groups WHERE canonical_key=$1", [
    user,
  ]);
  await pool.end();
}
