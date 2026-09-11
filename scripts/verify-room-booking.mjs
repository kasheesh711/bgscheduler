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
const tomorrow = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(Date.now() + 86400000));
const start = 540,
  end = 600;
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
    "INSERT INTO room_day_states(date,checked_at,evidence) VALUES($1,now(),$2) ON CONFLICT(date) DO UPDATE SET checked_at=now(),evidence=$2,lease_owner=null,lease_until=null,revision=room_day_states.revision+1",
    [tomorrow, { blocks: [], uncertain: [] }],
  );
  await pool.query(
    "INSERT INTO classroom_rooms(name,capacity,active) VALUES('Cool',2,true) ON CONFLICT(name) DO UPDATE SET active=true",
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
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !/server responded with a status of 409/.test(message.text())
    )
      failures.push(message.text());
  });
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
  if ((await page.title()) !== "BeGifted · Tutor rooms")
    throw new Error("Wrong page title");
  await page.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await page.getByRole("heading", { name: /rooms? available/ }).waitFor();
  if (!(await page.getByRole("checkbox", { name: "Start now" }).isDisabled()))
    throw new Error("Tomorrow permits Start now");
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
  await page.getByRole("heading", { name: `Classes · ${tomorrow}` }).waitFor();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("heading", { name: `Classes · ${today}` }).waitFor();
  await page.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await page.getByRole("heading", { name: `Classes · ${tomorrow}` }).waitFor();
  await page
    .getByRole("button", { name: "Available rooms", exact: true })
    .click();
  // A late response for Today must not replace the selected Tomorrow.
  let releaseToday;
  const heldToday = new Promise((resolve) => {
    releaseToday = resolve;
  });
  let sawToday;
  const requestedToday = new Promise((resolve) => {
    sawToday = resolve;
  });
  await page.route(`**/api/room/availability?date=${today}`, async (route) => {
    const response = await route.fetch();
    sawToday();
    await heldToday;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await requestedToday;
  await page.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await page.getByRole("heading", { name: /rooms? available/ }).waitFor();
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith(`availability?date=${today}`),
  );
  releaseToday();
  await oldResponse;
  await page.unroute(`**/api/room/availability?date=${today}`);
  if (
    (await page
      .getByRole("button", { name: "Tomorrow", exact: true })
      .getAttribute("aria-pressed")) !== "true"
  )
    throw new Error("Late response changed the selected date");
  await page.getByLabel("From", { exact: true }).fill(fmt(start));
  await page.getByLabel("Until", { exact: true }).fill(fmt(end));
  // Fresh uncertainty and stale evidence must never masquerade as zero rooms.
  await pool.query(
    "UPDATE room_day_states SET checked_at=now(),evidence=$2 WHERE date=$1",
    [
      tomorrow,
      { blocks: [], uncertain: [{ startMinute: start, endMinute: end }] },
    ],
  );
  await page.getByRole("button", { name: "Refresh room availability" }).click();
  await page
    .getByRole("heading", { name: "Availability needs checking" })
    .waitFor();
  if (await page.getByRole("heading", { name: "0 rooms available" }).count())
    throw new Error("Uncertainty shown as zero");
  await pool.query(
    "UPDATE room_day_states SET checked_at=now()-interval '6 minutes',evidence=$2 WHERE date=$1",
    [tomorrow, { blocks: [], uncertain: [] }],
  );
  await page.getByRole("button", { name: "Refresh room availability" }).click();
  await page
    .getByRole("heading", { name: "Availability unavailable" })
    .waitFor();
  await pool.query(
    "UPDATE room_day_states SET checked_at=now() WHERE date=$1",
    [tomorrow],
  );
  await page.getByRole("button", { name: "Refresh room availability" }).click();
  await page.getByRole("heading", { name: /rooms? available/ }).waitFor();
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
  const rival = `${user}-rival`;
  await pool.query(
    "INSERT INTO tutor_identity_groups(snapshot_id,canonical_key,display_name) VALUES($1,$2,'Rival Tutor')",
    [snapshot, rival],
  );
  await pool.query(
    "INSERT INTO room_tutor_links(line_user_id,canonical_key,display_name,status) VALUES($1,$1,'Rival Tutor','approved')",
    [rival],
  );
  await card.getByRole("button", { name: "Book room" }).click();
  const focus = (
    await pool.query("SELECT id FROM classroom_rooms WHERE name='Focus'")
  ).rows[0].id;
  await pool.query(
    "INSERT INTO room_reservations(date,room_id,line_user_id,canonical_key,start_minute,end_minute,idempotency_key,source) VALUES($1,$2,$3,$3,$4,$5,$6,'test')",
    [tomorrow, focus, rival, start, end, randomUUID()],
  );
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByText(
      "That room is no longer free for the whole interval. Choose another room or time.",
    )
    .waitFor();
  if (await page.getByRole("dialog").count())
    throw new Error("Conflict left old confirmation open");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Cool", exact: true }) })
    .getByRole("button", { name: "Book room" })
    .waitFor();
  if (
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM room_reservations WHERE date=$1 AND room_id=$2 AND status='confirmed'",
        [tomorrow, focus],
      )
    ).rows[0].count !== 1
  )
    throw new Error("Concurrent room double booking");
  await pool.query("DELETE FROM room_reservations WHERE line_user_id=$1", [
    rival,
  ]);
  await pool.query("DELETE FROM room_tutor_links WHERE line_user_id=$1", [
    rival,
  ]);
  await pool.query("DELETE FROM tutor_identity_groups WHERE canonical_key=$1", [
    rival,
  ]);
  if (
    await page
      .locator("nextjs-portal")
      .innerText()
      .catch(() => "")
      .then((text) => /Unhandled Runtime Error|Build Error/.test(text))
  )
    throw new Error("Framework error overlay");
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
    "PASS: tomorrow booking/cancellation, date switching and response races, uncertainty/staleness states, conflict alternatives, light/dark mobile/desktop, overflow, API auth, expired link",
  );
} finally {
  await browser.close();
  const rival = `${user}-rival`;
  await pool.query("DELETE FROM room_notifications WHERE line_user_id=$1", [
    rival,
  ]);
  await pool.query("DELETE FROM room_reservations WHERE line_user_id=$1", [
    rival,
  ]);
  await pool.query("DELETE FROM room_tutor_links WHERE line_user_id=$1", [
    rival,
  ]);
  await pool.query("DELETE FROM tutor_identity_groups WHERE canonical_key=$1", [
    rival,
  ]);
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
