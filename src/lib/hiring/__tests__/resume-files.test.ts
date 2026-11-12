import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { get } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken, put } from "@vercel/blob/client";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import { GET as readResume } from "@/app/api/hiring/resume/[id]/route";
import { GET as readBriefResume } from "@/app/api/hiring/brief/[token]/resume/route";
import { POST as requestUpload } from "@/app/api/internal/hiring-resume-upload/route";
import { saveApplication } from "../../../../scripts/hiring-seek";
import { deliveryAuthorization, resumeUploadAuthorization, verifyDeliveryAuthorization } from "../dispatch";
import { RESUME_TYPES } from "../model";
import { cleanResumeName, keepResume, resumePath, sniffResume, storedResume, storeResume } from "../resume-files";
import { bookingToken } from "../tokens";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: vi.fn(), del: vi.fn(), list: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ generateClientTokenFromReadWriteToken: vi.fn(), put: vi.fn() }));

const ID = "00000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const PDF_PATH = `hiring-resumes/${ID}/${SHA}.pdf`;
const DOCX_PATH = `hiring-resumes/${ID}/${SHA}.docx`;
const docx = (entry = "word/document.xml") =>
  new JSZip().file(entry, "<w:p>Invented text</w:p>").generateAsync({ type: "nodebuffer" });
/** The route reads one row: `select().from().where()`. */
const dbWith = (rows: unknown[]) => {
  const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
  vi.mocked(getDb).mockReturnValue(db as never);
  return db as unknown as Database;
};
const row = (patch = {}) => ({
  path: PDF_PATH,
  name: "cv.pdf",
  type: RESUME_TYPES.pdf,
  storedAt: new Date("2026-11-01T00:00:00Z"),
  ...patch,
});
const admin = (extra = {}) =>
  vi.mocked(auth).mockResolvedValue({ user: { email: "staff@example.com", role: "admin", ...extra } } as never);
const open = (id = ID) =>
  readResume(new Request(`https://app.example.com/api/hiring/resume/${id}`), { params: Promise.resolve({ id }) });
const blob = () => ({
  statusCode: 200,
  stream: new Blob(["%PDF-invented"]).stream(),
  blob: { size: 13 },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("sniffResume", () => {
  it("recognises PDF and DOCX by signature and refuses others", async () => {
    expect(sniffResume(Buffer.from("%PDF-1.4 invented"))).toEqual({ type: RESUME_TYPES.pdf, extension: "pdf" });
    expect(sniffResume(await docx())).toEqual({ type: RESUME_TYPES.docx, extension: "docx" });
    // A .pdf that holds text, and an old .doc, which the text extractor also refuses.
    expect(sniffResume(Buffer.from("just text in a file named cv.pdf"))).toBeNull();
    expect(sniffResume(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBeNull();
    expect(sniffResume(Buffer.alloc(0))).toBeNull();
  });
  it("accepts no ZIP that lacks word/document.xml, even if the name is in the bytes", async () => {
    expect(sniffResume(await docx("xl/workbook.xml"))).toBeNull();
    expect(sniffResume(await docx("word/document.xml.bak"))).toBeNull();
    const zip = await new JSZip().file("notes.txt", "word/document.xml").generateAsync({ type: "nodebuffer" });
    expect(sniffResume(zip)).toBeNull();
    expect(sniffResume(Buffer.from("PK\x03\x04word/document.xml", "latin1"))).toBeNull();
  });
});

describe("storedResume", () => {
  it("accepts only a stored path that matches the pattern", () => {
    expect(storedResume(ID, PDF_PATH, RESUME_TYPES.pdf)).toEqual({ path: PDF_PATH, extension: "pdf", type: RESUME_TYPES.pdf });
    expect(storedResume(ID, DOCX_PATH, RESUME_TYPES.docx)?.extension).toBe("docx");
    for (const path of [
      `https://store.blob.vercel-storage.com/${PDF_PATH}`,
      `/${PDF_PATH}`,
      `hiring-resumes/${ID}/../${SHA}.pdf`,
      `hiring-resumes/../other/${SHA}.pdf`,
      `hiring-resumes/00000000-0000-4000-8000-000000000002/${SHA}.pdf`,
      `hiring-resumes/${ID}/${SHA}.exe`,
      `hiring-resumes/${ID}/${"a".repeat(63)}.pdf`,
      `${PDF_PATH}\n`,
    ])
      expect(storedResume(ID, path, RESUME_TYPES.pdf)).toBeNull();
  });
  it("refuses a type that is not allowed, or that disagrees with the path", () => {
    expect(storedResume(ID, PDF_PATH, "text/html")).toBeNull();
    expect(storedResume(ID, PDF_PATH, RESUME_TYPES.docx)).toBeNull();
    expect(storedResume(ID, PDF_PATH, null)).toBeNull();
  });
});

describe("cleanResumeName", () => {
  it("removes quotes, line breaks and path parts, and uses the true extension", () => {
    expect(cleanResumeName('../../etc/"pass\r\nSet-Cookie: x=1\'.pdf', "pdf")).toBe("passSet-Cookie: x=1.pdf");
    expect(cleanResumeName("C:\\Users\\me\\cv.docx", "docx")).toBe("cv.docx");
    // A false extension does not survive.
    expect(cleanResumeName("cv.pdf", "docx")).toBe("cv.docx");
    expect(cleanResumeName("..", "pdf")).toBe("resume.pdf");
    expect(cleanResumeName("", "pdf")).toBe("resume.pdf");
    expect(cleanResumeName("\ud800", "pdf")).toBe("resume.pdf");
    expect(cleanResumeName(`${"x".repeat(500)}.pdf`, "pdf").length).toBeLessThanOrEqual(124);
  });
});

describe("GET /api/hiring/resume/[id]", () => {
  it("needs Hiring access", async () => {
    dbWith([row()]);
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await open()).status).toBe(401);
    admin({ role: "user" });
    expect((await open()).status).toBe(403);
    admin({ allowedPages: ["/search"] });
    expect((await open()).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });
  it("streams a PDF inline and a Word file as an attachment, with no-store and nosniff", async () => {
    admin({ allowedPages: ["/hiring"] });
    dbWith([row()]);
    vi.mocked(get).mockResolvedValueOnce(blob() as never);
    const pdf = await open();
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("Content-Type")).toBe(RESUME_TYPES.pdf);
    expect(pdf.headers.get("Cache-Control")).toBe("no-store");
    expect(pdf.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(pdf.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'self'; sandbox");
    expect(pdf.headers.get("Content-Disposition")).toBe("inline; filename*=UTF-8''cv.pdf");
    expect(await pdf.text()).toBe("%PDF-invented");
    // Only the stored path reaches storage.
    expect(get).toHaveBeenCalledWith(PDF_PATH, expect.objectContaining({ access: "private" }));

    dbWith([row({ path: DOCX_PATH, type: RESUME_TYPES.docx, name: "cv.docx" })]);
    vi.mocked(get).mockResolvedValueOnce(blob() as never);
    const word = await open();
    expect(word.headers.get("Content-Type")).toBe(RESUME_TYPES.docx);
    expect(word.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''cv.docx");
    expect(word.headers.get("Cache-Control")).toBe("no-store");
  });
  it("cleans the file name in Content-Disposition", async () => {
    admin();
    dbWith([row({ name: 'a"b\r\nX-Evil: 1/../ก ข(1)\'.pdf' })]);
    vi.mocked(get).mockResolvedValue(blob() as never);
    const header = (await open()).headers.get("Content-Disposition")!;
    expect(header).toBe("inline; filename*=UTF-8''%E0%B8%81%20%E0%B8%82%281%29.pdf");
    expect(header).not.toMatch(/["\r\n]/);
  });
  it("does not read storage for a stored path or type that breaks the rule", async () => {
    admin();
    for (const bad of [
      { path: `https://store.blob.vercel-storage.com/${PDF_PATH}` },
      { path: `hiring-resumes/${ID}/../../secret.pdf` },
      { type: "text/html" },
    ]) {
      dbWith([row(bad)]);
      const response = await open();
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("blob.vercel-storage");
    }
    expect(get).not.toHaveBeenCalled();
  });
  it("returns 404 with a clear message when the file is gone", async () => {
    admin();
    dbWith([row()]);
    vi.mocked(get).mockResolvedValue(null);
    const gone = await open();
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toMatch(/file is gone/i);

    dbWith([row({ path: null, type: null })]);
    const deleted = await open();
    expect(deleted.status).toBe(404);
    expect((await deleted.json()).error).toMatch(/deleted/i);

    dbWith([row({ path: null, type: null, storedAt: null })]);
    const none = await open();
    expect(none.status).toBe(404);
    expect((await none.json()).error).toMatch(/no original/i);

    dbWith([]);
    expect((await open()).status).toBe(404);
    expect((await open("not-a-uuid")).status).toBe(400);
  });
  it("does not reveal the storage address or token in an error", async () => {
    admin();
    dbWith([row()]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(get).mockRejectedValue(new Error("https://store.blob.vercel-storage.com/x?token=vercel_blob_rw_secret"));
    const response = await open();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("vercel");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("vercel_blob_rw");
  });
});

describe("GET /api/hiring/brief/[token]/resume", () => {
  const BOOKING = "00000000-0000-4000-8000-000000000002";
  const later = new Date(Date.now() + 86400000);
  const openBrief = (token: string) =>
    readBriefResume(new Request("https://app.example.com/api/hiring/brief/t/resume"), { params: Promise.resolve({ token }) });

  it("opens the candidate's file with the admin route's headers, and asks for no session", async () => {
    // One fake row serves both reads: the confirmed mock, then the candidate's stored file.
    dbWith([{ candidateId: ID, ...row() }]);
    vi.mocked(get).mockResolvedValue(blob() as never);
    const response = await openBrief(bookingToken(BOOKING, "brief", later));
    expect(response.status).toBe(200);
    expect(auth).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(PDF_PATH, { access: "private", useCache: false });
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline; /);
  });

  it("refuses a token of another kind, an expired or changed token, and a booking that is not a confirmed mock", async () => {
    dbWith([{ candidateId: ID, ...row() }]);
    const good = bookingToken(BOOKING, "brief", later);
    for (const token of [
      bookingToken(ID, "visit", later),
      bookingToken(ID, "mock", later),
      bookingToken(BOOKING, "brief", new Date(Date.now() - 1000)),
      `${good.slice(0, -2)}xx`,
      "not-a-token",
    ])
      expect((await openBrief(token)).status).toBe(404);
    // The token is valid, but no confirmed mock has that id (cancelled, moved, or never a mock).
    dbWith([]);
    expect((await openBrief(good)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/hiring-resume-upload", () => {
  const body = JSON.stringify({ candidateId: ID, sha256: SHA, extension: "pdf" });
  const send = (text: string, header: string | null) =>
    requestUpload(
      new Request("https://bgscheduler.vercel.app/api/internal/hiring-resume-upload", {
        method: "POST",
        body: text,
        headers: header ? { Authorization: header } : {},
      }),
    );
  it("refuses an unsigned or stale upload request", async () => {
    dbWith([{ id: ID }]);
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, "HMAC-HIRING 1.bad")).status).toBe(401);
    const stale = resumeUploadAuthorization(body, Date.now() - 121000);
    expect((await send(body, stale)).status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
    expect(generateClientTokenFromReadWriteToken).not.toHaveBeenCalled();
  });
  it("refuses a delivery signature, and delivery refuses an upload signature", async () => {
    dbWith([{ id: ID }]);
    expect((await send(body, deliveryAuthorization(body))).status).toBe(401);
    expect(generateClientTokenFromReadWriteToken).not.toHaveBeenCalled();
    expect(verifyDeliveryAuthorization(body, resumeUploadAuthorization(body))).toBe(false);
  });
  it("refuses a preview environment even with a valid signature", async () => {
    dbWith([{ id: ID }]);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await send(body, resumeUploadAuthorization(body))).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "true");
    expect((await send(body, resumeUploadAuthorization(body))).status).toBe(503);
    expect(getDb).not.toHaveBeenCalled();
  });
  it("issues a token only for the requested path", async () => {
    dbWith([{ id: ID }]);
    vi.mocked(generateClientTokenFromReadWriteToken).mockResolvedValue("client-token");
    const before = Date.now();
    const response = await send(body, resumeUploadAuthorization(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "client-token" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const options = vi.mocked(generateClientTokenFromReadWriteToken).mock.calls[0][0];
    expect(options).toMatchObject({
      pathname: PDF_PATH,
      maximumSizeInBytes: 15 * 1024 * 1024,
      allowedContentTypes: [RESUME_TYPES.pdf],
      addRandomSuffix: false,
    });
    expect(options.validUntil).toBeGreaterThanOrEqual(before + 5 * 60000);
    expect(options.validUntil).toBeLessThanOrEqual(Date.now() + 5 * 60000);
  });
  it("needs a candidate that exists and a path made only of checked parts", async () => {
    dbWith([]);
    expect((await send(body, resumeUploadAuthorization(body))).status).toBe(404);
    dbWith([{ id: ID }]);
    for (const bad of [
      { candidateId: "../../x", sha256: SHA, extension: "pdf" },
      { candidateId: ID, sha256: "../x", extension: "pdf" },
      { candidateId: ID, sha256: SHA, extension: "exe" },
      { candidateId: ID, sha256: SHA, extension: "pdf", path: "other" },
    ]) {
      const text = JSON.stringify(bad);
      expect((await send(text, resumeUploadAuthorization(text))).status).toBe(400);
    }
    expect(generateClientTokenFromReadWriteToken).not.toHaveBeenCalled();
  });
});

describe("storeResume", () => {
  it("refuses a file over 15 MB and a false extension before any upload", async () => {
    const db = dbWith([{ resumePath: null, resumeSha256: null }]);
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(15 * 1024 * 1024)]);
    await expect(storeResume(ID, { bytes: big, name: "cv.pdf" }, db)).rejects.toThrow(/15 MB/);
    await expect(storeResume(ID, { bytes: Buffer.from("text"), name: "cv.pdf" }, db)).rejects.toThrow(/supported/);
    expect(put).not.toHaveBeenCalled();
  });
  it("uses the path helper for the stored location", () => {
    expect(resumePath(ID, SHA, "pdf")).toBe(PDF_PATH);
  });
  it("the worker saves the text first, and reports a file that was not stored", async () => {
    const steps: string[] = [];
    const consume = vi.fn(async () => {
      steps.push("text");
      return ID;
    });
    const read = { application: {} as never, resumeFile: { bytes: Buffer.from("%PDF-"), name: "cv.pdf" } };
    const failing = vi.fn(async () => {
      steps.push("file");
      return false;
    });
    expect(await saveApplication(read, consume, failing)).toBe(false);
    expect(steps).toEqual(["text", "file"]);
    expect(failing).toHaveBeenCalledWith(ID, read.resumeFile);
    expect(await saveApplication(read, consume, async () => true)).toBe(true);
    // No file to keep is not a failure.
    const keep = vi.fn(async () => false);
    expect(await saveApplication({ ...read, resumeFile: null }, consume, keep)).toBe(true);
    expect(keep).not.toHaveBeenCalled();
  });
  it("a failed upload does not stop the import, and logs no candidate data", async () => {
    const db = dbWith([{ resumePath: null, resumeSha256: null }]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Somchai Jaidee could not upload" }, { status: 503 })),
    );
    await expect(keepResume(ID, { bytes: Buffer.from("%PDF-1.4"), name: "Somchai_Jaidee_CV.pdf" }, db)).resolves.toBe(false);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("Somchai");
    expect(logged).not.toContain(ID);
    expect(put).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
