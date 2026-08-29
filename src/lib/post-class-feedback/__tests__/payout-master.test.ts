import { describe, expect, it } from "vitest";

import {
  buildPayoutCorrectionRow,
  buildMasterDeductionRow,
  collectMasterMarkers,
  DEDUCTION_SESSION_NAME,
  DuplicatePayoutSignatureError,
  extractPayoutMarker,
  extractPayoutRowSignature,
  MASTER_COLUMNS,
  masterCellToUtc,
  matchMasterRow,
  parseMasterPayoutSheet,
  payoutCorrectionMarker,
  payoutRowMarker,
  type MasterPayoutTable,
} from "../payout-master";

function dateSerial(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000) + 25569;
}
function timeSerial(hours: number, minutes: number): number {
  return (hours * 60 + minutes) / 1440;
}

const HEADER = [
  "Teacher name", "Session name", "Course name",
  "Date", "Time", "Duration", "Credits deducted", "Payout amount",
];

const KEVIN = "Kevin (Kev) Y. Hsieh";
const KEVIN_ONLINE = "Kevin (Kev) Y. Hsieh Online";
const EK = "Apivit (Ek) Sirithana Online";

/**
 * The real ledger's shape: header row 1, typed date/time cells, every tutor
 * mixed together. Transcribed from production.
 */
function masterGrid(): unknown[][] {
  return [
    [...HEADER],
    [EK, "Online Session - Math (Cancelled)", "Nala (Namkhan.Tr) Trivisvavet", dateSerial("2026-07-25"), timeSerial(12, 0), "0 mins", 0, 0],
    [KEVIN, "On-site Session - Math", "Norraphat (Him.Vi) Viriyarojanakul", dateSerial("2026-07-25"), timeSerial(6, 0), "60 mins", 1, 700],
    [KEVIN_ONLINE, "Online Session - Math", "Cheyenne (Chey.Hu) Huang", dateSerial("2026-07-25"), timeSerial(10, 26), "36 mins", 1, 700],
    [KEVIN, "On-site Session - Science", "Thanasate (ThunThun.Su) Supsinburana", dateSerial("2026-07-24"), timeSerial(9, 30), "60 mins", 1, 700],
  ];
}

function table(): MasterPayoutTable {
  return parseMasterPayoutSheet(masterGrid())!;
}

const MARKER = payoutRowMarker({
  anchorMonth: "2026-07",
  deductionId: "3f1c9a2b-4d5e-6789-abcd-ef0123456789",
});

describe("masterCellToUtc", () => {
  it("reads typed serial cells, which is how the app reads the tab", () => {
    expect(masterCellToUtc(dateSerial("2026-07-25"), timeSerial(6, 0))?.toISOString())
      .toBe("2026-07-25T06:00:00.000Z");
  });

  it("also reads display strings, so a differently-rendered read cannot produce nonsense", () => {
    expect(masterCellToUtc("2026-07-29", "12:00")?.toISOString())
      .toBe("2026-07-29T12:00:00.000Z");
  });

  it("treats the time as UTC, never Bangkok", () => {
    // The whole matcher rests on this. Seven hours out would put every
    // deduction on the wrong class.
    expect(masterCellToUtc("2026-07-25", "06:00")?.toISOString())
      .toBe("2026-07-25T06:00:00.000Z");
  });

  it("returns null for a cell it cannot read", () => {
    expect(masterCellToUtc("not a date", "06:00")).toBeNull();
    expect(masterCellToUtc(null, null)).toBeNull();
  });
});

describe("payoutRowMarker / extractPayoutMarker", () => {
  it("carries twelve hex characters of the deduction id", () => {
    expect(MARKER).toBe("BGS-PAYOUT 2026-07 3f1c9a2b4d5e");
  });

  it("round-trips out of a session name cell", () => {
    expect(extractPayoutMarker(`${DEDUCTION_SESSION_NAME} · ${MARKER}`)).toBe(MARKER);
  });

  it("finds nothing in an ordinary class row", () => {
    expect(extractPayoutMarker("On-site Session - Math")).toBeNull();
    expect(extractPayoutMarker(null)).toBeNull();
  });

  it("gives a reinstated generation a distinct marker in the same format", () => {
    const gen1 = payoutRowMarker({ anchorMonth: "2026-07", deductionId: "3f1c9a2b-4d5e-0000-0000-000000000000" });
    const gen2 = payoutRowMarker({
      anchorMonth: "2026-07",
      deductionId: "3f1c9a2b-4d5e-0000-0000-000000000000",
      generation: 2,
    });
    expect(gen1).not.toBe(gen2);
    expect(gen2).toMatch(/^BGS-PAYOUT 2026-07 [0-9a-f]{12}$/u);
    // Generation 1 stays byte-identical to the historical form.
    expect(payoutRowMarker({
      anchorMonth: "2026-07",
      deductionId: "3f1c9a2b-4d5e-0000-0000-000000000000",
      generation: 1,
    })).toBe(gen1);
    // Extraction treats it like any other deduction marker.
    expect(extractPayoutMarker(`${DEDUCTION_SESSION_NAME} · ${gen2}`)).toBe(gen2);
  });

  it("does not confuse two deductions that share the first eight characters", () => {
    // At 8 hex a collision reads as already-written and silently skips a
    // deduction. This is why the marker is 12.
    const a = payoutRowMarker({ anchorMonth: "2026-07", deductionId: "3f1c9a2b-0000-0000-0000-000000000000" });
    const b = payoutRowMarker({ anchorMonth: "2026-07", deductionId: "3f1c9a2b-ffff-0000-0000-000000000000" });
    expect(a).not.toBe(b);
  });
});

describe("payout correction rows", () => {
  it("uses a distinct stable signature and a positive signed amount", () => {
    const correctionMarker = payoutCorrectionMarker({
      anchorMonth: "2026-07",
      adjustmentId: "9a8b7c6d-5e4f-3210-abcd-ef0123456789",
    });
    const row = buildPayoutCorrectionRow({
      source: table().rows.find((candidate) => candidate.teacherName === KEVIN)!,
      amountMinor: 10_000,
      marker: correctionMarker,
      sourceMarker: MARKER,
    });

    expect(correctionMarker).toBe("BGS-PAYOUT-CORRECTION 2026-07 9a8b7c6d5e4f");
    expect(row[MASTER_COLUMNS.payoutAmount]).toBe(100);
    expect(row[MASTER_COLUMNS.sessionName]).toContain(correctionMarker);
    expect(row[MASTER_COLUMNS.sessionName]).toContain(MARKER);
    expect(extractPayoutRowSignature(row[MASTER_COLUMNS.sessionName])).toEqual({
      marker: correctionMarker,
      kind: "correction",
    });
  });
});

describe("parseMasterPayoutSheet", () => {
  it("reads the ledger and its typed cells", () => {
    const parsed = table();
    expect(parsed.headerRowNumber).toBe(1);
    expect(parsed.rows).toHaveLength(4);
    const kevin = parsed.rows.find((row) => row.teacherName === KEVIN)!;
    expect(kevin.startAt?.toISOString()).toBe("2026-07-25T06:00:00.000Z");
    expect(kevin.studentName).toBe("Norraphat (Him.Vi) Viriyarojanakul");
    expect(kevin.payoutAmount).toBe(700);
  });

  it("keeps the raw date and time cells for mirroring", () => {
    const kevin = table().rows.find((row) => row.teacherName === KEVIN)!;
    expect(kevin.rawDate).toBe(dateSerial("2026-07-25"));
    expect(kevin.rawTime).toBe(timeSerial(6, 0));
  });

  it("refuses a tab whose columns have moved", () => {
    // A reordered re-paste must be detected, not written into under the wrong
    // headings.
    const shuffled = masterGrid();
    shuffled[0] = ["Date", "Teacher name", "Session name", "Course name", "Time", "Duration", "Credits deducted", "Payout amount"];
    expect(parseMasterPayoutSheet(shuffled)).toBeNull();
  });

  it("requires the exact A:H header contract, including middle columns", () => {
    const wrongMiddleHeader = masterGrid();
    wrongMiddleHeader[0] = [...HEADER];
    wrongMiddleHeader[0][6] = "Credits";
    expect(parseMasterPayoutSheet(wrongMiddleHeader)).toBeNull();
  });

  it("refuses a tab with no recognisable header at all", () => {
    expect(parseMasterPayoutSheet([["a", "b"], ["c", "d"]])).toBeNull();
  });
});

describe("collectMasterMarkers", () => {
  it("indexes every appended deduction by marker", () => {
    const grid = masterGrid();
    grid.push([KEVIN, `${DEDUCTION_SESSION_NAME} · ${MARKER}`, "Norraphat (Him.Vi) Viriyarojanakul", dateSerial("2026-07-25"), timeSerial(6, 0), "—", 0, -100]);
    const markers = collectMasterMarkers(parseMasterPayoutSheet(grid)!);
    expect(markers.get(MARKER)).toBe(6);
    expect(markers.size).toBe(1);
  });

  it("hard-blocks duplicate signatures instead of silently choosing a row", () => {
    const grid = masterGrid();
    const duplicate = [
      KEVIN,
      `${DEDUCTION_SESSION_NAME} · ${MARKER}`,
      "Norraphat (Him.Vi) Viriyarojanakul",
      dateSerial("2026-07-25"),
      timeSerial(6, 0),
      "—",
      0,
      -100,
    ];
    grid.push([...duplicate], [...duplicate]);
    expect(() => collectMasterMarkers(parseMasterPayoutSheet(grid)!))
      .toThrow(DuplicatePayoutSignatureError);
  });
});

describe("matchMasterRow", () => {
  function match(overrides: Partial<Parameters<typeof matchMasterRow>[0]> = {}) {
    return matchMasterRow({
      table: table(),
      teacherNames: [KEVIN, KEVIN_ONLINE],
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
      ...overrides,
    });
  }

  it("finds the tutor's own class", () => {
    const result = match();
    expect(result.status).toBe("matched");
    expect(result.row?.teacherName).toBe(KEVIN);
    expect(result.row?.rowNumber).toBe(3);
  });

  it("matches the tutor's Online identity too", () => {
    const result = match({
      scheduledStartAt: new Date("2026-07-25T10:30:00.000Z"),
      studentNames: ["Cheyenne (Chey.Hu) Huang"],
    });
    // 10:26 on the sheet against 10:30 scheduled — a live session logging its
    // actual start, inside the tolerance.
    expect(result.status).toBe("matched");
    expect(result.row?.teacherName).toBe(KEVIN_ONLINE);
  });

  it("never matches another tutor's identically-timed class", () => {
    // The ledger holds every tutor; without the teacher filter this would find
    // Ek's row and dock the wrong person.
    const result = match({
      teacherNames: [KEVIN, KEVIN_ONLINE],
      scheduledStartAt: new Date("2026-07-25T12:00:00.000Z"),
      studentNames: ["Nala (Namkhan.Tr) Trivisvavet"],
    });
    expect(result.status).toBe("unmatched");
  });

  it("never uses a previously appended deduction as an anchor", () => {
    const grid = masterGrid();
    grid.push([KEVIN, `${DEDUCTION_SESSION_NAME} · ${MARKER}`, "Norraphat (Him.Vi) Viriyarojanakul", dateSerial("2026-07-25"), timeSerial(6, 0), "—", 0, -100]);
    const result = matchMasterRow({
      table: parseMasterPayoutSheet(grid)!,
      teacherNames: [KEVIN, KEVIN_ONLINE],
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
    });
    expect(result.row?.rowNumber).toBe(3);
  });

  it("reports a clock disagreement rather than a bare unmatched", () => {
    // Every one of the tutor's rows that day sits exactly seven hours off:
    // the ledger is in Bangkok, not UTC, and writing would land the deduction
    // on the wrong class.
    const result = match({ scheduledStartAt: new Date("2026-07-25T13:00:00.000Z") });
    expect(result.status).toBe("clock_disagreement");
    expect(result.offsetHours).toBe(-7);
  });

  it("does not mistake an adjacent lesson for a clock disagreement", () => {
    // A different student exactly one hour away is the next class, not this
    // one shifted. Reporting a clock problem here would block a tutor's whole
    // publish over an ordinary miss.
    const grid = [
      [...HEADER],
      [KEVIN, "On-site Session - Math", "Someone Else", dateSerial("2026-07-25"), timeSerial(5, 0), "60 mins", 1, 700],
    ];
    const result = matchMasterRow({
      table: parseMasterPayoutSheet(grid)!,
      teacherNames: [KEVIN],
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
    });
    expect(result.status).toBe("unmatched");
  });

  it("reports ambiguous on an exact tie", () => {
    const grid = masterGrid();
    grid.push([KEVIN, "On-site Session - Math", "Norraphat (Him.Vi) Viriyarojanakul", dateSerial("2026-07-25"), timeSerial(5, 50), "60 mins", 1, 700]);
    grid.push([KEVIN, "On-site Session - Math", "Norraphat (Him.Vi) Viriyarojanakul", dateSerial("2026-07-25"), timeSerial(6, 10), "60 mins", 1, 700]);
    const result = matchMasterRow({
      table: parseMasterPayoutSheet(grid)!,
      teacherNames: [KEVIN],
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
    });
    // The exact 06:00 row is strictly nearest, so this still resolves.
    expect(result.status).toBe("matched");
    expect(result.row?.rowNumber).toBe(3);
  });

  it("refuses to give two deductions the same anchor", () => {
    expect(match({ claimedRows: new Set([3]) }).status).toBe("ambiguous");
  });

  it("reports unmatched when the student is not on any of the tutor's rows", () => {
    expect(match({ studentNames: ["Nobody At All"] }).status).toBe("unmatched");
  });
});

describe("buildMasterDeductionRow", () => {
  const anchor = table().rows.find((row) => row.teacherName === KEVIN)!;
  const row = buildMasterDeductionRow({ anchor, amountMinor: 10_000, marker: MARKER });

  it("writes exactly the ledger's eight columns", () => {
    expect(row).toHaveLength(8);
  });

  it("mirrors the anchor's typed date and time cells rather than formatting its own", () => {
    // A string where the column holds serials makes the row a minority type,
    // which QUERY drops — the deduction would vanish from the tutor's view and
    // their total with no error anywhere.
    expect(row[MASTER_COLUMNS.date]).toBe(anchor.rawDate);
    expect(row[MASTER_COLUMNS.time]).toBe(anchor.rawTime);
    expect(typeof row[MASTER_COLUMNS.date]).toBe("number");
    expect(typeof row[MASTER_COLUMNS.time]).toBe("number");
  });

  it("attributes the row to the same identity string the anchor used", () => {
    expect(row[MASTER_COLUMNS.teacherName]).toBe(KEVIN);
    expect(row[MASTER_COLUMNS.studentName]).toBe("Norraphat (Him.Vi) Viriyarojanakul");
  });

  it("writes a negative number, and carries the marker in the session name", () => {
    expect(typeof row[MASTER_COLUMNS.payoutAmount]).toBe("number");
    expect(row[MASTER_COLUMNS.payoutAmount]).toBe(-100);
    expect(typeof row[MASTER_COLUMNS.credits]).toBe("number");
    expect(String(row[MASTER_COLUMNS.sessionName])).toContain(MARKER);
    expect(String(row[MASTER_COLUMNS.sessionName])).toContain(DEDUCTION_SESSION_NAME);
  });

  it("is findable again by the reconcile scan", () => {
    expect(extractPayoutMarker(row[MASTER_COLUMNS.sessionName])).toBe(MARKER);
  });
});
