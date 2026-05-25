# AI Scheduler Model Comparison

Generated: 2026-05-22T07:47:18.943Z

| Candidate | Model | Reasoning | Exit | Score | Critical | p50 | p95 | Failed cases |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | `gpt-5.4-mini` | `low` | 1 | 222/260 | 4 | 4483 | 9190 | 8 |
| gpt-5.5-low | `gpt-5.5` | `low` | 1 | 223/260 | 3 | 4459 | 11353 | 7 |
| gpt-5.5-medium | `gpt-5.5` | `medium` | 1 | 220/260 | 3 | 11291 | 26424 | 8 |

Promotion gate: improve the expanded eval score with zero parent-ready critical failures and acceptable latency.

Raw JSON: `/tmp/bgscheduler/ai-scheduler-model-comparison.json`
