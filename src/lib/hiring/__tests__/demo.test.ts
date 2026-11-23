import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_ID, DEMO_STEPS, demoFetch, demoPacketRequest, demoPayload, demoPdf, demoRubric, demoState, markDemoPaper, resetDemo, setDemoStep } from "../demo";
import { buildFunnel } from "../funnel";
import { buildPipelineBoard } from "../pipeline-board";
import { buildRunSheet } from "../run-sheet";

const now = new Date("2026-11-24T08:00:00Z");
const post = (path: string, body: unknown) => demoFetch(path, { method: "POST", body: JSON.stringify(body) })!;
// The screens read the payload as JSON, so the builders get it the same way.
const wire = () => JSON.parse(JSON.stringify(demoPayload(now)));
const stageAt = (step: number) => {
  setDemoStep(step);
  return demoPayload(now).candidates[0].stage;
};

describe("hiring demo mode", () => {
  beforeEach(resetDemo);

  it("moves the demo candidate through the stages of the real flow", () => {
    expect(DEMO_STEPS.map((_, step) => stageAt(step))).toEqual(
      ["new", "new", "pre_screen", "onsite_booked", "onsite_booked", "onsite_booked", "onsite_booked", "hired"],
    );
  });

  it("gives every step a payload that the screens' own builders accept", () => {
    const columns = DEMO_STEPS.map((_, step) => {
      setDemoStep(step);
      const data = wire();
      expect(() => buildFunnel(data, now)).not.toThrow();
      expect(() => buildRunSheet({ ...data, now })).not.toThrow();
      return buildPipelineBoard(data, now).columns.find((column) => column.cards.some((card) => card.id === DEMO_ID))?.key ?? null;
    });
    // Before the HR call the candidate is not on the board; then the candidate moves right and never back.
    expect(columns[0]).toBeNull();
    expect(new Set(columns.slice(1)).size).toBeGreaterThanOrEqual(5);
  });

  it("moves on when the presenter uses the real buttons", async () => {
    setDemoStep(1);
    post("/api/hiring", { action: "call_result", id: DEMO_ID, result: "good" });
    expect(demoState().step).toBe(2);
    setDemoStep(4);
    expect(demoPayload(now).papers.some((paper) => paper.candidateId === DEMO_ID)).toBe(false);
    markDemoPaper();
    expect(demoPayload(now).papers.some((paper) => paper.candidateId === DEMO_ID)).toBe(true);
    setDemoStep(5);
    await post("/api/hiring/brief/demo/rubric", { items: { accuracy: 10 }, comments: "" }).json();
    post("/api/hiring/brief/demo/decision", { decision: "hire", reason: "" });
    expect(demoState().step).toBe(6);
    post(`/api/hiring/review/${DEMO_ID}`, { action: "submit", behavioral: "Calm.", offerType: "part_time" });
    expect(demoPayload(now).reviewAccess).toEqual({ hr: false, gift: true });
    post(`/api/hiring/review/${DEMO_ID}`, { action: "sign", packetId: "x", decision: "hire", reason: "" });
    expect(demoState().step).toBe(7);
  });

  it("closes the candidate on a No, and a bad call", () => {
    setDemoStep(5);
    post("/api/hiring/brief/demo/decision", { decision: "reject", reason: "Unclear lesson." });
    expect(demoPayload(now).candidates[0].stage).toBe("rejected");
    setDemoStep(1);
    post("/api/hiring", { action: "stop", id: DEMO_ID });
    expect(demoPayload(now).candidates[0].stage).toBe("stopped");
  });

  it("answers every hiring request itself, except the two read-only ones", () => {
    expect(demoFetch("/api/search")).toBeNull();
    expect(demoFetch("/api/hiring?capacity=1")).toBeNull();
    expect(demoFetch("/api/hiring/pdf-runtime/pdf.worker.mjs")).toBeNull();
    // Only a read goes through: a write to the same address is answered here.
    expect(post("/api/hiring?capacity=1", {})).not.toBeNull();
    for (const path of ["/api/hiring", "/api/hiring?head=Peat", "/api/hiring/onboarding", "/api/hiring/uploads", "/api/hiring/book/x", "/api/hiring/resume/1"])
      expect(demoFetch(path), path).not.toBeNull();
    // An upload cannot start: the server step that would give the browser a storage address is refused.
    expect(post("/api/hiring", { action: "file_intent" }).status).toBe(409);
    expect(post("/api/hiring/uploads", {}).status).toBe(503);
  });

  it("makes a PDF that a viewer can open", () => {
    const text = new TextDecoder().decode(demoPdf("Title (demo)", ["Line"]));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
  });
});

it("previews the packet with the selected standard letter and saves nothing", async () => {
  const response = demoFetch(`/api/hiring/review/${DEMO_ID}`, { method: "POST", body: JSON.stringify({ action: "preview", behavioral: "Calm and clear.", offerType: "full_time" }) })!;
  const html = await response.text();
  expect(html).toContain("full-time Mathematics tutor");
  expect(html).toContain("Calm and clear.");
  const review = await demoFetch(`/api/hiring/review/${DEMO_ID}`)!.json();
  expect(review.packet?.offerType ?? null).not.toBe("full_time");
});

describe("the demo packet in the real design", () => {
  beforeEach(resetDemo);
  const url = `/api/hiring/review/${DEMO_ID}`;

  it("asks the server for HR's preview and for the sent packet, and for nothing else", () => {
    expect(demoPacketRequest(url, { method: "POST", body: JSON.stringify({ action: "preview", behavioral: "Calm and clear.", offerType: "specialist" }) }))
      .toMatchObject({ draft: true, behavioral: "Calm and clear.", offer: expect.stringContaining("specialist Mathematics tutor") });
    expect(demoPacketRequest(`${url}?file=html`)).toBeNull(); // no packet sent yet
    expect(demoPacketRequest(url, { method: "POST", body: JSON.stringify({ action: "submit", behavioral: "Calm and clear.", offerType: "part_time" }) })).toBeNull();
    post(url, { action: "submit", behavioral: "Calm and clear.", offerType: "part_time" });
    expect(demoPacketRequest(`${url}?file=html`)).toMatchObject({ draft: false, behavioral: "Calm and clear." });
    expect(demoPacketRequest(`${url}?file=resume`)).toBeNull();
    expect(demoPacketRequest("/api/hiring/review/00000000-0000-4000-8000-000000000010?file=html")).toBeNull();
  });

  it("renders the real packet document with the demo values", async () => {
    const { demoReviewDocument } = await import("../demo-packet");
    const html = await demoReviewDocument({ draft: true, behavioral: "Calm <b>and</b> clear.", offer: "Dear Nicha", rubric: demoRubric() }, "https://example.test");
    expect(html).toContain("<title>Hiring review | Demo – Nicha Suwan</title>");
    expect(html).toContain("Preview. Not sent to Gift.");
    expect(html).toContain("ATS breakdown");
    expect(html).toContain("53 / 60");
    expect(html).toContain("Calm &lt;b&gt;and&lt;/b&gt; clear.");
    expect(html).toContain("https://example.test/api/hiring/review/demo-packet?file=resume");
  });
});
