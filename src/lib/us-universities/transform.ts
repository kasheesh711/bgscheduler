// ── IPEDS row → record transform (pure) ────────────────────────────────
// Maps merged, upper-cased source rows into typed institution + completion
// records. All keys are upper-case (the import upper-cases CSV headers).

import {
  coerceIpedsNumber,
  coerceIpedsInt,
  coerceIpedsBool,
  emptyToNull,
  deriveCip2,
  parseAdmConsiderations,
} from "./parser";
import { AWARD_LEVEL_LABELS } from "./constants";
import type { IpedsInstitutionInsert, IpedsCompletionInsert } from "./types";

/** Per-institution source rows, one (upper-cased) row per contributing table. */
export interface SourceRows {
  HD?: Record<string, string>;
  ADM?: Record<string, string>;
  DRVADM?: Record<string, string>;
  DRVEF?: Record<string, string>;
  EF2024D?: Record<string, string>;
  DRVGR?: Record<string, string>;
  DRVOM?: Record<string, string>;
  DRVCOST?: Record<string, string>;
  COST1?: Record<string, string>;
  NETPRICE?: Record<string, string>;
  DRVC?: Record<string, string>;
}

function buildRaw(src: SourceRows): Record<string, unknown> {
  // Compact drill-down payload: the ~1-row "frequently used" tables only.
  return {
    HD: src.HD ?? {},
    DRVADM: src.DRVADM ?? {},
    DRVEF: src.DRVEF ?? {},
    DRVGR: src.DRVGR ?? {},
    DRVCOST: src.DRVCOST ?? {},
    DRVC: src.DRVC ?? {},
  };
}

export function buildInstitution(
  src: SourceRows,
  unitId: number,
  dataYear: string,
): IpedsInstitutionInsert {
  const hd = src.HD ?? {};
  const adm = src.ADM ?? {};
  const drvadm = src.DRVADM ?? {};
  const ef = src.DRVEF ?? {};
  const efd = src.EF2024D ?? {};
  const gr = src.DRVGR ?? {};
  const om = src.DRVOM ?? {};
  const dcost = src.DRVCOST ?? {};
  const c1 = src.COST1 ?? {};
  const np = src.NETPRICE ?? {};
  const dc = src.DRVC ?? {};
  const num = coerceIpedsNumber;
  const int = coerceIpedsInt;

  const docResearch = int(dc.DOCDEGRS) ?? 0;
  const docPro = int(dc.DOCDEGPP) ?? 0;
  const docOther = int(dc.DOCDEGOT) ?? 0;
  const hasDoc = dc.DOCDEGRS != null || dc.DOCDEGPP != null || dc.DOCDEGOT != null;

  return {
    dataYear,
    unitId,
    // Directory
    instName: (hd.INSTNM ?? "").trim() || `Institution ${unitId}`,
    alias: emptyToNull(hd.IALIAS),
    city: emptyToNull(hd.CITY),
    stateAbbr: emptyToNull(hd.STABBR),
    zip: emptyToNull(hd.ZIP),
    region: int(hd.OBEREG),
    website: emptyToNull(hd.WEBADDR),
    admissionsUrl: emptyToNull(hd.ADMINURL),
    netPriceCalcUrl: emptyToNull(hd.NPRICURL),
    control: int(hd.CONTROL),
    sector: int(hd.SECTOR),
    iclevel: int(hd.ICLEVEL),
    locale: int(hd.LOCALE),
    instSize: int(hd.INSTSIZE),
    hbcu: coerceIpedsBool(hd.HBCU),
    landGrant: coerceIpedsBool(hd.LANDGRNT),
    carnegieBasic: int(hd.C21BASIC),
    latitude: num(hd.LATITUDE),
    longitude: num(hd.LONGITUD),
    countyName: emptyToNull(hd.COUNTYNM),
    // Admissions + test scores
    applicantsTotal: int(adm.APPLCN),
    admitsTotal: int(adm.ADMSSN),
    enrolledTotal: int(adm.ENRLT),
    acceptanceRate: num(drvadm.DVADM01),
    yieldRate: num(drvadm.DVADM04),
    admConsiderations: parseAdmConsiderations(adm),
    satSubmitPct: num(adm.SATPCT),
    actSubmitPct: num(adm.ACTPCT),
    satReadingP25: int(adm.SATVR25),
    satReadingP75: int(adm.SATVR75),
    satMathP25: int(adm.SATMT25),
    satMathP75: int(adm.SATMT75),
    actCompositeP25: int(adm.ACTCM25),
    actCompositeP75: int(adm.ACTCM75),
    // Enrollment + demographics
    enrollmentTotal: int(ef.ENRTOT),
    enrollmentUg: int(ef.EFUG),
    enrollmentGrad: int(ef.EFGRAD),
    fte: num(ef.FTE),
    pctWomen: num(ef.PCTENRW),
    pctFullTimeFirstTime: num(ef.PCTFT1ST),
    pctWhite: num(ef.PCTENRWH),
    pctBlack: num(ef.PCTENRBK),
    pctHispanic: num(ef.PCTENRHS),
    pctAsianPacIsl: num(ef.PCTENRAP),
    pctAmInd: num(ef.PCTENRAN),
    pctTwoOrMore: num(ef.PCTENR2M),
    pctUnknown: num(ef.PCTENRUN),
    pctNonresident: num(ef.PCTENRNR),
    pctInState: num(ef.RMINSTTP),
    pctOutOfState: num(ef.RMOUSTTP),
    // Retention + outcomes
    retentionFt: num(efd.RET_PCF),
    retentionPt: num(efd.RET_PCP),
    studentFacultyRatio: num(efd.STUFACR),
    gradRateTotal: num(gr.GRRTTOT),
    gradRateBach6yr: num(gr.GBA6RTT),
    transferOutRate: num(gr.TRRTTOT),
    omAward8yr: num(om.OM1TOTLAWDP8),
    omStillEnrolled8yr: num(om.OM1TOTLENYP8),
    // Cost (chgNay3 = published tuition+fees 2024-25, academic-year reporter;
    // in-state = charge type 2, out-of-state = type 3. The *PY* program-reporter
    // variants do not exist for types 2/3 in this extract — AY is the source.)
    appFeeUg: int(c1.APPLFEEU),
    tuitionInState: int(c1.CHG2AY3),
    tuitionOutState: int(c1.CHG3AY3),
    totalPriceInState: int(dcost.CINSON),
    totalPriceOutState: int(dcost.COTSON),
    roomBoardAmt: int(c1.RMBRDAMT),
    avgNetPrice: int(np.NPIST2),
    // Degree mix
    degBachelors: int(dc.BASDEG),
    degMasters: int(dc.MASDEG),
    degDoctoral: hasDoc ? docResearch + docPro + docOther : null,
    degAssociate: int(dc.ASCDEG),
    raw: buildRaw(src),
  };
}

/**
 * Map already-filtered C2024_A rows into completion records. Callers must pass
 * only 6-digit detail rows (this institution, MAJORNUM=1, AWLEVEL=5, 6-digit
 * CIPCODE != 99, CTOTALT > 0) — the 2-/4-digit nested rollups are dropped
 * upstream (see isSixDigitCip) to avoid triple-counting the same degrees.
 */
export function buildCompletions(
  rows: Array<Record<string, string>>,
  cipTitleMap: Map<string, string>,
  dataYear: string,
): IpedsCompletionInsert[] {
  return rows.map((r) => {
    const cipCode = (r.CIPCODE ?? "").trim();
    const awardLevel = coerceIpedsInt(r.AWLEVEL);
    return {
      dataYear,
      unitId: coerceIpedsInt(r.UNITID) ?? 0,
      cipCode,
      cipTitle: cipTitleMap.get(cipCode) ?? null,
      cip2: deriveCip2(cipCode),
      awardLevel,
      awardLevelLabel:
        awardLevel != null ? (AWARD_LEVEL_LABELS[awardLevel] ?? null) : null,
      count: coerceIpedsInt(r.CTOTALT) ?? 0,
    };
  });
}
