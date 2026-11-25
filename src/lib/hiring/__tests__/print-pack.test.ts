import { describe, expect, it } from "vitest";
import { coversHtml, printToken, readPrintToken } from "../print-pack";
import { bookingToken, readBookingToken } from "../tokens";

const secret = "test-secret";
const candidate = "44444444-4444-4444-8444-444444444444";

describe("print links", () => {
  it("open the day, or one candidate on the day, until the Bangkok day ends", () => {
    const token = printToken("2026-11-26", null, secret);
    expect(readPrintToken(token, new Date("2026-11-26T16:59:00Z"), secret)).toEqual({ date: "2026-11-26", candidateId: null });
    expect(() => readPrintToken(token, new Date("2026-11-26T17:00:00Z"), secret)).toThrow(/expired/);
    expect(readPrintToken(printToken("2026-11-26", candidate, secret), new Date("2026-11-26T01:00:00Z"), secret).candidateId).toBe(candidate);
  });
  it("refuse a changed token, another secret and a booking token, and a print token opens no booking", () => {
    const now = new Date("2026-11-26T01:00:00Z");
    const token = printToken("2026-11-26", null, secret);
    const [payload, signature] = token.split(".");
    const other = Buffer.from(JSON.stringify({ date: "2026-11-27", exp: 9999999999 })).toString("base64url");
    expect(() => readPrintToken(`${other}.${signature}`, now, secret)).toThrow();
    expect(() => readPrintToken(`${payload}.${signature}`, now, "other")).toThrow();
    const booking = bookingToken(candidate, "paper-check", new Date("2026-12-01T00:00:00Z"), secret);
    expect(() => readPrintToken(booking, now, secret)).toThrow();
    expect(() => readBookingToken(token, now, secret)).toThrow();
  });
});

describe("cover pages", () => {
  const item = { candidateId: candidate, subject: "Economics", fileId: null, head: "Gift",
    start: new Date("2026-11-26T02:00:00Z"), end: new Date("2026-11-26T04:00:00Z"), mockAt: new Date("2026-11-26T06:15:00Z") };
  it("print one A4 page per candidate with the name, subject, Bangkok exam time and mock", () => {
    const html = coversHtml([{ ...item, name: "Kasom Kantavanich" }, { ...item, name: "Nayana Bhat", mockAt: null }]);
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    expect(html).toContain("<h1><em>Kasom</em> Kantavanich</h1>");
    expect(html).toContain("<dd>Economics</dd>");
    expect(html).toContain("<dd>Thursday 26 November 2026</dd>");
    expect(html).toContain("<dd>09:00–11:00</dd>");
    expect(html).toContain("<dd>13:15 with Gift</dd>");
    expect(html.split("Mock teaching")).toHaveLength(2);
  });
  it("escapes the candidate's name", () => {
    expect(coversHtml([{ ...item, name: "<b>Eve</b> & co" }])).toContain("<h1><em>&#60;b&#62;Eve&#60;/b&#62;</em> &#38; co</h1>");
  });
});

describe("the tagged print message", () => {
  it("keeps the {person} tag and doubles any other brace, so a name cannot break the message", async () => {
    const { taggedText } = await import("../recruitment");
    expect(taggedText("{person} Papers\n09:00 Jo {Jojo} Smith · Economics")).toBe("{person} Papers\n09:00 Jo {{Jojo}} Smith · Economics");
  });
});
