# Autowriter: post first, review internally

Date: 27 October 2026 (Bangkok). Task: CW-20261027-autowriter-post-first.

## Policy and scope

Kevin asked for speed and uptime as the primary goals. The local change posts a valid draft without pre-post model judges. It records `qualityReview: deferred` and a null judge verdict. It retains internal audits, their evidence and the quality dashboard. Optional reviews no longer add to the dashboard action count.

Style and presentation failures remain recorded but do not block a post. Source identity, absent-student and no-lesson checks, empty or oversized answers, unresolved placeholders, evidence integrity, billing, existing teacher feedback, one-POST claims and read-back checks remain. A source summary can be used after transcript fallback, including Thai summaries. No content is invented when the source is missing. Existing held rows are not released by this code change.

Transcript-first source timing and tutor-specific writer order are unchanged. This change alone does not remove recording waits, writer timeouts or Wise service delays.

## Did the pre-post judges help?

Read-only production query: 13 October 2026 00:00 Bangkok through 27 October 2026, query time recorded in the private evidence. Counts are calls, not independent quality ratings.

- 661 judge calls across 215 classes; recorded spend USD 1.7622. Median call 6.599 s; 90th percentile 29.596 s. The two levels normally run together, so their durations must not be added.
- 96 failed judge calls (53 high, 43 medium). These include infrastructure failures; they do not prove poor feedback.
- 48 classes had at least one rejected draft. Of these, 37 later posted and 11 remained held at query time.
- Eight posted classes have explicit repair records. Four have a later verdict pinned to the original post: three approve and one cosmetic defect. Four have no stored later verdict. A cached source audit for one of those four rates the final text accurate, but this is not evidence of human acceptance.
- The source evidence supports useful corrections: two repairs removed homework that the lesson had not assigned.
- The judge can also remove useful text. One repair removed the whole opening topics sentence. The later source audit found a dangling “We also covered” and missing core percentage rules, a cosmetic defect caused by the deletion.

Conclusion: the judges have caused real repairs, but eight repair records do not prove eight improvements. Rejections, later successful posts and clean final text do not by themselves establish the benefit of the first judge. A complete precision/recall estimate needs source review of the rejected and accepted original drafts; that work is not claimed here.

## Where the time goes

| Stage | Calls | Median | 90th percentile |
|---|---:|---:|---:|
| GPT-6 Luna writer | 249 | 134.543 s | 180.003 s |
| GPT-6.1 Sol writer | 170 | 10.514 s | 22.259 s |
| Judge, per call | 661 | 6.599 s | 29.596 s |
| Transcription, recorded call | 177 | 88.005 s | 122.894 s |

These are observed calls across different classes and include failures. They are not a paired model benchmark or end-to-end posting times. The larger measured writer delay is Luna at max reasoning, rather than the judges.

## Terra exploration

[OpenAI documents GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) as a fast model for writing and other tasks. It supports structured output and low reasoning effort. The [public OpenRouter endpoint catalog](https://openrouter.ai/api/v1/models/openai/gpt-6.1-terra/endpoints) lists `openai/gpt-6.1-terra`, including standard, Flex and fast routes. At inspection the standard route listed USD 1 per million input tokens and USD 5 per million output tokens; its latency and throughput fields were null.

A suitable next comparison is Terra-low against Sol-low on the same retained lessons, measuring valid-draft rate, source mistakes, p50/p90 latency and fallback rate. Keep the existing zero-retention route requirements. Do not route latency-sensitive posts through Flex. No production model was changed and no paid comparison was run. Model access on this account and zero-retention routing still need a bounded live check.

## Checks and release

Passed locally: 1,464 relevant unit tests across the autowriter and its components (the retired switch test was removed; the affected config and system-line tests were rerun); 144 applicable database cases across the complete job/store run and focused follow-up checks; TypeScript for changed files and their imports; lint for changed code; whitespace check; and the 332-route production surface guard.

The database checks used an isolated PostgreSQL 16 cluster and fake Wise/model operations. The first run exposed expectations for the retired blocking judges; those tests were updated or removed where the behavior no longer exists. Offline judging tests remain.

Full-repository type checking was stopped because it includes archived local worktrees; a focused project config was used without changing the repository config. The full release build, all-project test suite, production deployment, bulk retry, live feedback write and paid model comparison were not performed. Run the full release gate before deployment. No post-deployment speed or uptime result is claimed.

Private query and source-audit evidence: `.feedback-autowriter/post-first-20261027/`. No student text is included in this committed report.
