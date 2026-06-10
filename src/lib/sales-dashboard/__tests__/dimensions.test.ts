import { describe, expect, it } from "vitest";
import {
  buildSalesDimensions,
  filterSlimTransactions,
  sortSlimTransactions,
  toSlimAdditionalTransaction,
  toSlimTransaction,
} from "../dimensions";
import type { ParsedAdditionalSaleRow, ParsedNormalSaleRow } from "../types";

let rowCounter = 0;

function normalRow(overrides: Partial<ParsedNormalSaleRow>): ParsedNormalSaleRow {
  rowCounter += 1;
  return {
    sourceMonth: "2026-01-01",
    sourceLabel: "2026-01 Jan",
    rowNumber: rowCounter,
    studentNickname: "Nong A",
    program: "Math",
    packageHours: "20 Hours",
    numberOfStudents: 1,
    paymentAmount: 10_000,
    salesRepresentative: "Alice",
    paymentDate: "2026-01-10",
    enrollmentType: "New Student",
    programWiseName: "Mathematics",
    packageHoursClean: "20 Hours",
    validUntil: null,
    churnStatus: "",
    raw: { secret: "never-serialized" },
    ...overrides,
  };
}

function additionalRow(overrides: Partial<ParsedAdditionalSaleRow>): ParsedAdditionalSaleRow {
  rowCounter += 1;
  return {
    sourceMonth: "2026-01-01",
    sourceLabel: "2026-01 Jan",
    rowNumber: rowCounter,
    studentNickname: "Nong A",
    salesType: "Books",
    packageName: "Workbook",
    paymentAmount: 500,
    paymentDate: "2026-01-15",
    raw: { secret: "never-serialized" },
    ...overrides,
  };
}

const TODAY = new Date("2026-06-01T05:00:00.000Z");

describe("buildSalesDimensions", () => {
  it("aggregates the (rep, month) grain with T/N/R splits and merges rep-key variants", () => {
    const result = buildSalesDimensions({
      normalRows: [
        normalRow({ salesRepresentative: "Alice", paymentDate: "2026-01-05", paymentAmount: 1_000, enrollmentType: "Trial" }),
        normalRow({ salesRepresentative: " alice ", paymentDate: "2026-01-20", paymentAmount: 9_000, enrollmentType: "New Student" }),
        normalRow({ salesRepresentative: "Alice", paymentDate: "2026-02-10", paymentAmount: 4_000, enrollmentType: "Renewal" }),
        normalRow({ salesRepresentative: "Bob", paymentDate: "2026-01-12", paymentAmount: 2_000, enrollmentType: "New Student" }),
      ],
      additionalRows: [],
      projection: null,
      today: TODAY,
    });

    expect(result.months).toEqual(["2026-01-01", "2026-02-01"]);
    expect(result.reps).toEqual([
      { rep: "Alice", month: "2026-01-01", rev: 10_000, count: 2, revT: 1_000, revN: 9_000, revR: 0, cntT: 1, cntN: 1, cntR: 0 },
      { rep: "Alice", month: "2026-02-01", rev: 4_000, count: 1, revT: 0, revN: 0, revR: 4_000, cntT: 0, cntN: 0, cntR: 1 },
      { rep: "Bob", month: "2026-01-01", rev: 2_000, count: 1, revT: 0, revN: 2_000, revR: 0, cntT: 0, cntN: 1, cntR: 0 },
    ]);
  });

  it("skips rows with blank nicknames everywhere, mirroring the landing payload", () => {
    const result = buildSalesDimensions({
      normalRows: [normalRow({ studentNickname: "   " })],
      additionalRows: [additionalRow({ studentNickname: "" })],
      projection: null,
      today: TODAY,
    });

    expect(result.months).toEqual([]);
    expect(result.reps).toEqual([]);
    expect(result.students).toEqual([]);
  });

  it("credits trial conversion to the rep on the student's first Trial row", () => {
    const result = buildSalesDimensions({
      normalRows: [
        normalRow({ studentNickname: "Mint", salesRepresentative: "Alice", paymentDate: "2026-01-05", enrollmentType: "Trial" }),
        // Conversion sold by Bob — still credited to Alice.
        normalRow({ studentNickname: "Mint", salesRepresentative: "Bob", paymentDate: "2026-01-15", enrollmentType: "New Student" }),
        normalRow({ studentNickname: "Tan", salesRepresentative: "Alice", paymentDate: "2026-02-01", enrollmentType: "Trial" }),
      ],
      additionalRows: [],
      projection: null,
      today: TODAY,
    });

    const alice = result.repFunnels.find((funnel) => funnel.rep === "Alice");
    const bob = result.repFunnels.find((funnel) => funnel.rep === "Bob");
    expect(alice).toMatchObject({ trialsHandled: 2, trialsConverted: 1, medianDaysToConvert: 10 });
    expect(bob).toMatchObject({ trialsHandled: 0, trialsConverted: 0, medianDaysToConvert: null });
  });

  it("caps funnel top programs at 5 plus an Other bucket", () => {
    const programs = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];
    const result = buildSalesDimensions({
      normalRows: programs.map((program, index) => normalRow({
        program,
        programWiseName: program,
        paymentAmount: (programs.length - index) * 1_000,
        studentNickname: `Student ${index}`,
      })),
      additionalRows: [],
      projection: null,
      today: TODAY,
    });

    const funnel = result.repFunnels.find((entry) => entry.rep === "Alice");
    expect(funnel?.topPrograms).toHaveLength(6);
    expect(funnel?.topPrograms.slice(0, 5).map((entry) => entry.name)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    expect(funnel?.topPrograms.at(-1)).toEqual({ name: "Other", rev: 3_000 });
  });

  it("aggregates the (program, month) grain with distinct student counts", () => {
    const result = buildSalesDimensions({
      normalRows: [
        normalRow({ studentNickname: "Mint", programWiseName: "Coding", paymentAmount: 5_000, enrollmentType: "New Student" }),
        normalRow({ studentNickname: "MINT ", programWiseName: "Coding", paymentAmount: 3_000, enrollmentType: "Renewal" }),
        normalRow({ studentNickname: "Tan", programWiseName: "Coding", paymentAmount: 2_000, enrollmentType: "Trial" }),
      ],
      additionalRows: [],
      projection: null,
      today: TODAY,
    });

    expect(result.programs).toEqual([
      {
        program: "Coding",
        month: "2026-01-01",
        rev: 10_000,
        count: 3,
        students: 2,
        revT: 2_000,
        revN: 5_000,
        revR: 3_000,
      },
    ]);
  });

  it("aggregates package bands per month and counts unparseable packages without dropping revenue", () => {
    const result = buildSalesDimensions({
      normalRows: [
        normalRow({ packageHoursClean: "20 Hours", paymentAmount: 8_000 }),
        normalRow({ packageHoursClean: "20 Hours", paymentAmount: 8_000 }),
        normalRow({ packageHoursClean: "Camp Package", paymentAmount: 12_000 }),
      ],
      additionalRows: [],
      projection: null,
      today: TODAY,
    });

    const band20 = result.packages.find((entry) => entry.packageBand === "20h");
    const other = result.packages.find((entry) => entry.packageBand === "Other");
    expect(band20).toEqual({
      packageBand: "20h",
      packageLabel: "20 Hours",
      hours: 20,
      month: "2026-01-01",
      rev: 16_000,
      count: 2,
      totalHoursSold: 40,
    });
    expect(other).toMatchObject({ rev: 12_000, count: 1, totalHoursSold: null });
    expect(result.unparsedPackageCount).toBe(1);

    const totalRev = result.packages.reduce((sum, entry) => sum + entry.rev, 0);
    expect(totalRev).toBe(28_000);
  });

  it("builds the additional-revenue mix by month and salesType", () => {
    const result = buildSalesDimensions({
      normalRows: [],
      additionalRows: [
        additionalRow({ salesType: "Books", paymentAmount: 500, paymentDate: "2026-01-15" }),
        additionalRow({ salesType: "Books", paymentAmount: 700, paymentDate: "2026-01-20" }),
        additionalRow({ salesType: "Exam Fee", paymentAmount: 1_200, paymentDate: "2026-02-02" }),
      ],
      projection: null,
      today: TODAY,
    });

    expect(result.additionalMix).toEqual([
      { month: "2026-01-01", salesType: "Books", rev: 1_200, count: 2 },
      { month: "2026-02-01", salesType: "Exam Fee", rev: 1_200, count: 1 },
    ]);
  });

  it("builds the student directory with live-recomputed status and name variants", () => {
    const result = buildSalesDimensions({
      normalRows: [
        normalRow({
          studentNickname: "Mint",
          paymentDate: "2026-01-05",
          paymentAmount: 1_000,
          enrollmentType: "Trial",
          programWiseName: "Coding",
        }),
        normalRow({
          studentNickname: "MINT ",
          paymentDate: "2026-01-15",
          paymentAmount: 9_000,
          enrollmentType: "New Student",
          validUntil: "2026-01-31",
          programWiseName: "Coding",
          salesRepresentative: "Alice",
        }),
      ],
      additionalRows: [
        additionalRow({ studentNickname: "mint", paymentDate: "2026-02-01", paymentAmount: 500 }),
      ],
      projection: null,
      today: TODAY,
    });

    expect(result.students).toHaveLength(1);
    const mint = result.students[0];
    expect(mint.key).toBe("mint");
    expect(mint.displayNameVariants.sort()).toEqual(["MINT", "Mint", "mint"].sort());
    expect(mint.firstSeen).toBe("2026-01-05");
    expect(mint.lastPaymentDate).toBe("2026-02-01");
    expect(mint.totalRevenue).toBe(10_500);
    expect(mint.txnCount).toBe(2);
    expect(mint.addTxnCount).toBe(1);
    expect(mint.programs).toEqual(["Coding"]);
    expect(mint.reps).toEqual(["Alice"]);
    // validUntil 2026-01-31 + 14d = 2026-02-14 < today → Churned (live),
    // regardless of any stored churn_status.
    expect(mint.status).toBe("Churned");
    expect(mint.latestValidUntil).toBe("2026-01-31");
    expect(mint.decisionDate).toBe("2026-02-14");
  });

  it("marks additional-only students Pending instead of guessing a cohort status", () => {
    const result = buildSalesDimensions({
      normalRows: [],
      additionalRows: [additionalRow({ studentNickname: "Fern" })],
      projection: null,
      today: TODAY,
    });

    expect(result.students[0]).toMatchObject({ status: "Pending", latestValidUntil: null, decisionDate: null });
  });

  it("passes the projection target through only when it is sheet-sourced", () => {
    const base = { normalRows: [], additionalRows: [], today: TODAY };
    expect(buildSalesDimensions({ ...base, projection: { targetMonthlyRevenue: 3_500_000, targetSource: "projection" } }).targetMonthlyRevenue).toBe(3_500_000);
    expect(buildSalesDimensions({ ...base, projection: { targetMonthlyRevenue: 4_000_000, targetSource: "fallback" } }).targetMonthlyRevenue).toBeNull();
    expect(buildSalesDimensions({ ...base, projection: null }).targetMonthlyRevenue).toBeNull();
  });
});

describe("toSlimTransaction / toSlimAdditionalTransaction", () => {
  it("never serializes the raw jsonb column", () => {
    const slim = toSlimTransaction(normalRow({ validUntil: "2026-02-28" }));
    const slimAdditional = toSlimAdditionalTransaction(additionalRow({}));

    expect("raw" in slim).toBe(false);
    expect("raw" in slimAdditional).toBe(false);
    expect(JSON.stringify(slim)).not.toContain("never-serialized");
    expect(JSON.stringify(slimAdditional)).not.toContain("never-serialized");
    expect(JSON.stringify({ rows: [slim, slimAdditional] })).not.toContain('"raw"');
  });

  it("derives band/hours/program and the normalized student key", () => {
    const slim = toSlimTransaction(normalRow({
      studentNickname: "  Nong   A ",
      packageHoursClean: "30 Hours",
      programWiseName: "Mathematics",
      validUntil: "2026-02-28",
    }));

    expect(slim).toMatchObject({
      student: "Nong A",
      studentKey: "nong a",
      program: "Mathematics",
      packageLabel: "30 Hours",
      band: "30h",
      hours: 30,
      validUntil: "2026-02-28",
      kind: "normal",
    });
  });

  it("maps additional rows with their salesType and no rep/program/band", () => {
    const slim = toSlimAdditionalTransaction(additionalRow({ salesType: "Books", packageName: "Workbook" }));

    expect(slim).toMatchObject({
      rep: "",
      program: "",
      band: "",
      hours: null,
      packageLabel: "Workbook",
      salesType: "Books",
      kind: "additional",
    });
  });
});

describe("filterSlimTransactions", () => {
  const rows = [
    toSlimTransaction(normalRow({ salesRepresentative: "Alice Wong", studentNickname: "Mint", paymentDate: "2026-01-10", packageHoursClean: "20 Hours", programWiseName: "Coding" })),
    toSlimTransaction(normalRow({ salesRepresentative: "Bob", studentNickname: "Tan", paymentDate: "2026-02-10", packageHoursClean: "Trial", programWiseName: "Math" })),
    toSlimAdditionalTransaction(additionalRow({ studentNickname: "Mint", paymentDate: "2026-03-01" })),
  ];

  it("matches reps through normalizeRepKey on both sides", () => {
    const filtered = filterSlimTransactions(rows, { rep: "  alice   wong " });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].studentKey).toBe("mint");
  });

  it("excludes additional rows from rep/program/band filters but includes them for students", () => {
    expect(filterSlimTransactions(rows, { band: "" })).toHaveLength(0);
    expect(filterSlimTransactions(rows, { program: "" })).toHaveLength(0);
    const mint = filterSlimTransactions(rows, { student: "MINT" });
    expect(mint).toHaveLength(2);
    expect(mint.map((row) => row.kind).sort()).toEqual(["additional", "normal"]);
  });

  it("applies the from/to date window", () => {
    expect(filterSlimTransactions(rows, { from: "2026-02-01", to: "2026-02-28" })).toHaveLength(1);
  });
});

describe("sortSlimTransactions", () => {
  it("orders newest-first deterministically", () => {
    const rows = sortSlimTransactions([
      toSlimTransaction(normalRow({ paymentDate: "2026-01-10" })),
      toSlimTransaction(normalRow({ paymentDate: "2026-03-10" })),
      toSlimTransaction(normalRow({ paymentDate: "2026-02-10" })),
    ]);
    expect(rows.map((row) => row.date)).toEqual(["2026-03-10", "2026-02-10", "2026-01-10"]);
  });
});
