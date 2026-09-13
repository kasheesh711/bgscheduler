/** API formatting + PDF build timings, 2026-09-13. Synthetic four-page sources.
 * Source: docs/operations/progress-paper-model-benchmark-2026-09-13.json.
 * Excludes upload, queueing, DOCX conversion and Blob transfer. Never extrapolate
 * these short-paper measurements to long papers or to a different model/effort.
 * Codex CLI experiments are deliberately excluded from website ETA evidence.
 */
const releaseTimings = [
  {
    "model": "gpt-5.6-luna",
    "effort": "none",
    "pages": 4,
    "durationsMs": [
      14928,
      18583,
      15517,
      18129
    ]
  },
  {
    "model": "gpt-5.6-luna",
    "effort": "low",
    "pages": 4,
    "durationsMs": [
      16790,
      16636,
      14922,
      16478
    ]
  },
  {
    "model": "gpt-5.6-luna",
    "effort": "medium",
    "pages": 4,
    "durationsMs": [
      23794,
      26854,
      22358,
      21431
    ]
  },
  {
    "model": "gpt-5.6-luna",
    "effort": "high",
    "pages": 4,
    "durationsMs": [
      32052,
      69972,
      45224,
      59382
    ]
  },
  {
    "model": "gpt-5.6-terra",
    "effort": "none",
    "pages": 4,
    "durationsMs": [
      13311,
      18550,
      11292
    ]
  },
  {
    "model": "gpt-5.6-terra",
    "effort": "low",
    "pages": 4,
    "durationsMs": [
      20141,
      20988,
      22167,
      23072
    ]
  },
  {
    "model": "gpt-5.6-terra",
    "effort": "medium",
    "pages": 4,
    "durationsMs": [
      21734,
      27435,
      16777
    ]
  },
  {
    "model": "gpt-5.6-terra",
    "effort": "high",
    "pages": 4,
    "durationsMs": [
      42338,
      25977,
      37257,
      35078
    ]
  },
  {
    "model": "gpt-5.6-terra",
    "effort": "xhigh",
    "pages": 4,
    "durationsMs": [
      62423,
      47802,
      97652,
      64556
    ]
  },
  {
    "model": "gpt-5.6-sol",
    "effort": "none",
    "pages": 4,
    "durationsMs": [
      21605,
      28782,
      16828,
      18389
    ]
  },
  {
    "model": "gpt-5.6-sol",
    "effort": "low",
    "pages": 4,
    "durationsMs": [
      31962,
      26479,
      29243
    ]
  },
  {
    "model": "gpt-5.6-sol",
    "effort": "medium",
    "pages": 4,
    "durationsMs": [
      35120,
      44088,
      48056,
      41778
    ]
  },
  {
    "model": "gpt-5.6-sol",
    "effort": "high",
    "pages": 4,
    "durationsMs": [
      56365,
      47032,
      52879,
      49879
    ]
  },
  {
    "model": "gpt-6-astra",
    "effort": "low",
    "pages": 4,
    "durationsMs": [
      26892,
      27671,
      28143
    ]
  },
  {
    "model": "gpt-6-astra",
    "effort": "medium",
    "pages": 4,
    "durationsMs": [
      31950,
      31483,
      32798,
      32213
    ]
  },
  {
    "model": "gpt-6-astra",
    "effort": "high",
    "pages": 4,
    "durationsMs": [
      49161,
      63292,
      53658
    ]
  }
] as const;
export function releaseFormattingTimings(model: unknown, effort: unknown, pages: number): number[] {
  if (!Number.isFinite(pages) || pages < 3 || pages > 6) return [];
  return releaseTimings.filter(row => row.model === model && row.effort === effort).flatMap(row => [...row.durationsMs]);
}
