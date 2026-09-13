# Progress Tests: formatting model comparison

**Astra low had the strongest measured source preservation. Sol none/low are the cheaper candidates for the next formatter iteration, but both omitted subpart marks. None of the tested configurations is yet proven ready for automatic printing.** More reasoning did not consistently improve fidelity, and the current working-space contract still compresses students' answer areas. The production model has not been changed by this evaluation.

The requested continuation through Codex is **complete: 108 outcomes across Luna, Terra, Sol and Astra**, using the signed-in desktop runtime and Codex allowance. No API-key requests were made after the user declined a top-up. There were **95 complete responses, all producing both PDFs**, **25 source-check failures among those responses**, and **13 capture timeouts**. Seventy runs passed all measured source checks and PDF construction; that is not a print-readiness guarantee.

The earlier paid API experiment remains incomplete: **163 evaluable matrix outcomes out of 279 planned**, plus **16 exploratory probes**. Forty-one account-credit rejections are excluded from model failure rates. Codex supplies additional repeatability evidence, but its runtime is different and cannot complete the missing API repeats or validate the live website's API behavior.

## Decision and operating cost

The table weights the three source types equally. Costs assume a new paper with no cache discount and the documented cache-write premium on all input tokens; they include formatting and a private rubric, but exclude grading, reports, hosting, storage and tutor time. The actual production paper mix is unknown.

| Model and effort | Strict passes in captured native-PDF trials | Source checks, mean | Estimated API cost / new paper | Per 1,000 new papers |
|---|---:|---:|---:|---:|
| Luna medium | 4/5 | 98.17% | $0.0114 | $11.36 |
| Terra high | 4/5 | 98.97% | $0.1307 | $130.66 |
| Sol none | 4/5 | 99.23% | $0.1860 | $186.02 |
| Sol low | 3/4 | 99.23% | $0.1955 | $195.46 |
| Sol medium | 4/5 | 99.23% | $0.2137 | $213.68 |
| Astra low | 4/4 | 100.00% | $0.5083 | $508.25 |

A strict pass means a complete structured response, both PDFs built, every deterministic source-preservation check passed, and model completion within the application's current 110-second deadline. It **does not mean ready for students**: missing source marks, a draft rubric and other flagged limitations still require tutor review. A 100% check score is not proof that every word, diagram crop or rubric is correct.

Luna medium costs about one seventeenth as much as Sol none in this mix, but its mathematical transcription errors make the savings less attractive for dense assessment papers. Terra sometimes preserved the long paper at low or medium effort, but was less consistent across the other fixtures. Increasing Terra to high did not guarantee better results on the long paper.

Astra low costs about 2.7 times Sol none in the same mix. It did show a concrete quality advantage: it preserved question 24's printed 2/2/4 subpart marks, which Sol none/low/medium/high omitted from the student paper even when the private rubric retained them. Astra also preserved all checked content on completed explicit-image and Codex runs. Its long-paper completion was slow, with two of three Codex attempts at both low and medium hitting the 300-second capture limit. That prevents a confident recommendation to use it for every upload.

Tutor time can dominate the API bill. At an **illustrative** $20/hour, Sol's extra $0.175 per paper over Luna medium is equivalent to about **31 seconds of tutor time**. If it saves that much correction time on average, it pays for itself. Review duration was not measured, so this is a break-even calculation, not a staffing-cost forecast. The interactive report lets the reader change volume, hourly cost and review/correction assumptions.

Formatting cost is per new paper version, not per student who uses it. Selecting an already approved library paper reuses its artifacts. A failed PDF build also resumes from the saved model response rather than paying for extraction again. Replacement uploads, student-work grading and report generation have separate processing costs.

## The actual 17-page paper

This source contains 32 main questions, 18 additional worksheet equations, a worked-mistake example, diagrams and a final answer-link page. The earlier 30-question extraction is incomplete. Most settings have only **one captured long-paper trial**; Terra none has two. These observations are useful regression evidence, not reliable population error-rate estimates.

| Setting | Model time | API cost from returned usage | Result |
|---|---:|---:|---|
| Luna medium | 61.4 s | $0.0219 | Changed definitions/expressions in question 24; omitted the complete worked example |
| Terra low | 54.1 s | $0.2194 | Preserved checked equations, but omitted Q24's subpart marks |
| Terra medium | 49.8 s | $0.2050 | Preserved checked equations, but omitted Q24's subpart marks |
| Terra high | 78.8 s | $0.2450 | Changed the requested expression in question 24 |
| Sol none | 70.9 s | $0.3670 | Equations preserved; omitted Q24's subpart marks; 10 paper pages + 5 key pages |
| Sol low | 82.4 s | $0.3754 | Equations preserved; omitted Q24's subpart marks; 12 paper pages + 5 key pages |
| Sol medium | 95.6 s | $0.4008 | Equations preserved; omitted Q24's subpart marks |
| Astra low | 104.6 s | $0.9992 | Passed all checks, but close to the deadline |
| Astra medium | 144.1 s | $1.1615 | Content checks passed; missed the application's deadline |

Local PDF generation was around 2.5 seconds at the median across the matrices. That timing excludes the model, browser upload, queue delay, Blob writes and network download. Model latency was the dominant measured processing cost; changing PDF viewers alone cannot remove it.

## Errors and effort levels

The native-PDF matrix captured 107 outcomes: 104 complete structured responses, two requests stopped at the benchmark's 300-second capture limit with unknown usage, and one incomplete Terra-max response. All 104 complete responses built both PDFs with the revised shared renderer. There were 60 strict passes and 28 results beyond the application's 110-second deadline; these categories overlap with other failures.

Content errors included a fraction being interpreted as an exponent, a lost denominator, a changed requested expression, missing worksheet items, incomplete worked examples and inconsistent source-page coverage. Some outputs scored over 99% overall while still containing a material mathematical error. Retrying only transport failures would miss those errors.

**All 17 native-PDF trials at max effort exceeded 110 seconds.** Nine of 19 xhigh trials exceeded it. Sol none/low/medium/high all preserved the checked equations in their captured native-PDF trials but all omitted Q24's subpart marks. Sol xhigh preserved those marks, while three of its five trials missed 110 seconds. Increasing effort therefore did not establish a reliable improvement in overall usable output. Higher effort is therefore a poor default for this formatting task under the current timeout.

PDF build failures and visual defects are tracked separately. A Sol-low response produced an orphaned subpart label before a page break in renderer v2. The shared renderer v3 keeps labels with their following equations, and the saved finalist responses were replayed without another model call. The matrix's original v2 PDFs and timings are retained; the replay is not counted as another successful API experiment.

The explicit-image matrix captured 56 complete responses and both PDFs for every response, with 38 strict passes and three deadline misses. On the long source, Luna/Terra/Sol each failed one or more checked items in both captured image trials at low and medium effort. Astra preserved the checked content in those trials, although three of its four long-image trials exceeded 110 seconds. Converting every PDF to explicit images is therefore **not a demonstrated general improvement**.

The image-input fingerprint was reproduced without paid requests and matched the original experiment exactly. A separate eight-request transcription probe and eight-request full-paper input experiment were exploratory; their different prompts/input resolutions are not pooled into the matrix rankings. A promising single Luna image result did not reproduce in the larger image matrix.

## Completed Codex comparison

The 108 trials cover all four models at low/medium/high/xhigh/max on all three documents. Low and medium have three repeats per document (nine trials per setting); high/xhigh/max have one repeat per document (three trials per setting). Codex does not list none for these models, so the earlier API trials remain the only evidence for none. Ultra is outside this fixed document-transformation comparison.

| Model | Effort | Content + PDF passes | Source errors | 300-second timeouts | Median captured time |
|---|---|---:|---:|---:|---:|
| Luna | low | 6/9 | 3 | 0 | 36.2s |
| Luna | medium | 6/9 | 3 | 0 | 60.2s |
| Terra | low | 4/9 | 5 | 0 | 36.8s |
| Terra | medium | 4/9 | 5 | 0 | 42.0s |
| Sol | low | 6/9 | 3 | 0 | 55.8s |
| Sol | medium | 6/9 | 3 | 0 | 67.2s |
| Astra | low | 7/9 | 0 | 2 | 64.8s |
| Astra | medium | 7/9 | 0 | 2 | 68.3s |

All 95 complete structured responses built both BeGifted PDFs. No model attempted a tool call. The 13 incomplete outcomes were capture timeouts: the six long Luna/Terra/Sol xhigh/max runs, all five first-sweep long Astra runs, and the final long Astra-low and Astra-medium repeats. Their content and usage are unknown; they are not counted as bad mathematical answers or PDF renderer crashes.

On the 17-page source:

- **Luna low and medium:** 0/3 full source-check passes each. Both were consistent on the six short-paper trials, but the long papers changed variables, omitted worksheet material or altered mathematics. Medium did not remove those failures.
- **Terra low and medium:** 0/3 each. There were missing subpart marks and often omitted worked examples. Some short scan trials also returned inconsistent page metadata that could prevent readiness.
- **Sol low:** 0/3 full passes because all three omitted the same 2/2/4 subpart marks. The checked equations, main questions, worksheet and worked example were retained in all three. Model times were 144.2, 149.7 and 154.3 seconds.
- **Sol medium:** 0/3 full passes; it also omitted those marks, and two repeats introduced worksheet or worked-example errors. It took 149.1, 177.8 and 229.0 seconds. There is no measured value gain over low here.
- **Astra low and medium:** 1/3 each. The completed papers passed every measured check, including subpart marks; each setting had two 300-second timeouts. Successful long runs took 269.6 seconds at low and 289.6 seconds at medium.

The conditional source score can therefore read 100% for Astra while its complete-pass rate is only 7/9 overall: unanswered long requests have unknown quality, and six of the nine trials are short papers. The short and long results must be considered separately.

These are **Codex elapsed times**, including startup and runtime transport behavior, not website latency. Codex used its default output cap, attached 1,600-pixel images and its own system context. Four processes ran concurrently; the included Astra-low typed preflight ran alone. API-key environment variables, tools, plugins, hooks, web access and delegation were disabled. Each trial had an ephemeral read-only working directory. Requested model/effort and the desktop CLI version are preserved in the manifest; the provider backend snapshot is not pinned.

No dollar charges are inferred from Codex tokens or the shared account allowance. The cost table above uses the earlier **API** measurements. At the tested mix, Astra low adds about **$0.313 per paper / $313 per 1,000** over Sol low. At an illustrative $20 tutor-hour, that is about **56 seconds of review time per paper**. The experiment did not measure whether Astra saves that time, and its additional latency also matters.

## Quality and visual review

Every successfully generated matrix paper and marking scheme was rasterized page by page and checked for text coordinates outside the page. Finalist long-paper PDFs were also rendered independently with Poppler for visual inspection, including their equations, original diagram, worked example, page breaks, headers and footers. Sol none used a compact ten-page assessment layout; Sol low used twelve pages. No claim is made that every page of every model's output received a manual review.

**Working space is a release issue beyond the model's source-check score.** On the long native-PDF source, Sol none/low/medium and Astra low each requested only 34 writing lines across the 32 main questions, including one line for the six-mark final question. They appear to have counted the printed dotted answer lines while compressing the surrounding blank working area. The first Codex Sol-low and second Astra-low papers reproduced this pattern. All eleven pages of each were inspected: the main content, original rectangle and worked example were present, but the mathematical working space was too limited. Luna medium in Codex retained much more space (220 lines) while making other content errors. This is why neither a 100% source-check score nor more reasoning proves a usable paper. The extraction contract and page layout need a separate working-area fix and visual validation before release; this benchmark's prompt was kept fixed instead of changing it halfway through the comparison.

The deterministic evaluator checks question presence and numbering, supplied total and subpart marks, canonical mathematical structures in the **rendered blocks**, selected Thai wording, tables, continuation content, source-figure references and separation of private keys. Correct text hidden in the internal question record cannot conceal an incorrect equation in a rendered block. Coverage checks also expose source metadata problems that could prevent readiness even when the visible questions appear complete.

These checks have limits: they do not compare all wording, verify every crop boundary, solve every rubric, assess arbitrary handwriting or measure educational grading/report quality. Manual inspection found source-specific limitations, including worksheet items without printed marks, that appropriately remain flagged. Tutor approval is still necessary.

The synthetic uploaded marking key contains a known wrong answer in question 6(b). Its input bytes were held fixed across every setting; this comparison tests preservation of that supplied key, **not correctness of the key**. A grading-quality evaluation must use a separately reviewed answer set. The ground-truth formula for source question 29 was corrected after visual inspection, and all results were rescored with the same final evaluator. The worked example is accepted when fully preserved either as a source crop or as an exact transcription. Sentence punctuation inside mathematical delimiters is normalized; this corrected a false failure for Luna medium in the API matrix and Luna high in Codex. Decimal values, denominators, exponents and equation targets still remain distinct, verified with scorer regression checks. Raw responses were never edited to improve a model's score. Final manual review found the omitted Q24 subpart allocations, so three checks for visible 2/2/4 marks were added uniformly to every API and Codex result. Hidden rubric marks do not pass these checks. This changed Sol's apparent perfect results and the recommendation; the final tables supersede interim scores. The scorer has regression checks for missing, misplaced and incorrect marks. Source-question content and per-part working areas still need broader validation.

## Method, evidence and uncertainty

The planned native-PDF matrix is 23 settings × three documents × three repeats: Luna, Terra and Sol at none/low/medium/high/xhigh/max; Astra at low/medium/high/xhigh/max. The separate image matrix is four models × low/medium × the same three documents × three repeats, with page images at a longest side of 1,600 pixels. Both use fixed source bytes, the same formatting instructions and strict schema, a 32,000-token output limit, standard service tier, no tools, and no hidden retries.

Documents were a four-page typed mathematics fixture with a private one-page key, its raster-only copy without a key, and the actual 17-page regression source. The two four-page fixtures share content, further limiting diversity. These are controlled regression fixtures, not a representative random sample of tutors' uploads.

Four requests ran concurrently per matrix; the matrices overlapped, and a brief two-worker exploratory experiment also overlapped. Model/effort order rotated across documents and repeats. Latency is therefore an observation under that traffic and local/provider load, not an isolated service-level guarantee. The benchmark captured responses for up to 300 seconds to recover usage and separately applied the production 110-second deadline.

Interrupted repeats made the samples unbalanced. Aggregate cost and fidelity give each document type equal weight; raw pass fractions and median times use the available trials. Missing usage is never assigned zero. If a document type has no measured cost, its aggregate cost is unknown. Fidelity aggregates likewise remain unscored when a fixture has no complete response.

Zero failures in five independent trials would still have a Wilson 95% upper failure bound of about 43%; with four trials it is about 49%. Here the repeated documents are correlated, so even those illustrative intervals overstate how much the sample can establish. **Do not interpret 5/5 as a production failure rate of 0%.** Completing the remaining repetitions improves repeatability evidence, but a stronger release-quality estimate also needs a broader collection of independently reviewed papers.

Aggregate measurements are stored in [the JSON evidence](progress-paper-model-benchmark-2026-09-13.json). It includes input/scorer hashes and per-fixture trial counts. Private raw responses, source PDFs, generated PDFs and detailed checks stay under ignored `output/progress-tests-pdf/`. Formatting prompt version and all parameters are preserved in each experiment manifest.

## Cost accounting

| Experiment | Known usage-based API estimate |
|---|---:|
| Native-PDF matrix | $20.1773 |
| 1,600-pixel image matrix | $7.6471 |
| Focused transcription probes | $0.0572 |
| Full-paper input probes | $2.1536 |
| **Total recorded estimate** | **$30.0351** |

This is approximately **$30.04 in known API usage**, not a reconciled invoice. Two timed-out requests did not return usage. Several in-flight requests were interrupted when the runners stopped and may also have incurred charges. Account-credit rejections do not contain usage and are excluded from model rankings. The evidence does not establish that these tests alone exhausted the shared account's balance.

Per-million-token rates checked on 13 September 2026 are $0.20 input / $0.02 cached / $1.20 output for [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), $2 / $0.20 / $12 for [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), $4 / $0.40 / $20 for [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), and $10 / $1 / $50 for [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). Sol's prices are promotional through at least 21 November 2026. All tested inputs are below the long-context pricing threshold.

Reported cache writes are priced at 1.25 times the normal input rate. Output usage already includes reasoning tokens; they are not charged a second time in this calculation. The interactive report offers actual cached usage, standard uncached input and conservative new-paper assumptions. Vercel compute, private Blob storage, downloads, human review, student-work grading and progress-report generation require separate budgeting.

## Remaining work before a model switch or deployment

The user declined further API funding, so missing paid repeats remain unrun and the rejected-attempt evidence is retained. A future API validation should use additional independent papers with reviewed equations, diagrams, multilingual content and real scan quality. The complete private browser upload → persisted processing → authenticated PDF preview flow on the long source with the selected model still needs validation, including approval and subsequent reload retaining the same artifacts. Codex output replays can test rendering and source preservation but cannot establish this live API behavior.

The upload-to-PDF code changes remain on the isolated release branch. Existing launch time, counters, approvals and Wise publication history are untouched. Production deployment is pending the subpart-mark and working-space fixes plus the remaining live validation checks. No production migration, model switch or deployment was performed as part of this evaluation.

## All captured settings

All tables use the final shared scorer, including visible subpart marks. Unscored/unknown entries have missing complete responses or usage; they are not zeros. The API trials below retain the 110-second strict deadline. Codex passes use its separate 300-second capture window and must not be compared as production pass rates.

### Native visual PDFs

| Model | Effort | Trials | Strict passes | Response / PDF / deadline errors | Source checks | Median time | New-paper API cost |
|---|---|---:|---:|---|---:|---:|---:|
| 5.6-luna | none | 5 | 4/5 | 0 / 0 / 0 | 92.7% | 15.9s | $0.0094 |
| 5.6-luna | low | 5 | 4/5 | 0 / 0 / 0 | 97.7% | 14.2s | $0.0100 |
| 5.6-luna | medium | 5 | 4/5 | 0 / 0 / 0 | 98.2% | 21.3s | $0.0114 |
| 5.6-luna | high | 5 | 4/5 | 0 / 0 / 0 | 98.7% | 46.8s | $0.0153 |
| 5.6-luna | xhigh | 4 | 1/4 | 0 / 0 / 2 | 98.6% | 107.2s | $0.0224 |
| 5.6-luna | max | 5 | 0/5 | 0 / 0 / 5 | 99.0% | 167.9s | $0.0328 |
| 5.6-terra | none | 5 | 3/5 | 0 / 0 / 0 | 98.6% | 10.8s | $0.0992 |
| 5.6-terra | low | 5 | 2/5 | 0 / 0 / 0 | 98.1% | 18.2s | $0.1116 |
| 5.6-terra | medium | 4 | 1/4 | 0 / 0 / 0 | 97.6% | 19.4s | $0.1077 |
| 5.6-terra | high | 5 | 4/5 | 0 / 0 / 0 | 99.0% | 34.3s | $0.1307 |
| 5.6-terra | xhigh | 5 | 3/5 | 0 / 0 / 1 | 98.7% | 62.1s | $0.1740 |
| 5.6-terra | max | 4 | 0/4 | 1 / 0 / 4 | Unscored | 194.2s | $0.3492 |
| 5.6-sol | none | 5 | 4/5 | 0 / 0 / 0 | 99.2% | 19.1s | $0.1860 |
| 5.6-sol | low | 4 | 3/4 | 0 / 0 / 0 | 99.2% | 28.0s | $0.1955 |
| 5.6-sol | medium | 5 | 4/5 | 0 / 0 / 0 | 99.2% | 41.6s | $0.2137 |
| 5.6-sol | high | 5 | 4/5 | 0 / 0 / 0 | 99.2% | 50.6s | $0.2516 |
| 5.6-sol | xhigh | 5 | 2/5 | 0 / 0 / 3 | 100.0% | 131.4s | $0.3423 |
| 5.6-sol | max | 4 | 0/4 | 1 / 0 / 4 | Unscored | 157.3s | Unknown |
| 6-astra | low | 4 | 4/4 | 0 / 0 / 0 | 100.0% | 25.2s | $0.5083 |
| 6-astra | medium | 5 | 4/5 | 0 / 0 / 1 | 100.0% | 30.0s | $0.5703 |
| 6-astra | high | 4 | 3/4 | 0 / 0 / 1 | 100.0% | 55.2s | $0.6966 |
| 6-astra | xhigh | 5 | 2/5 | 0 / 0 / 3 | 100.0% | 116.5s | $0.8971 |
| 6-astra | max | 4 | 0/4 | 1 / 0 / 4 | Unscored | 196.4s | Unknown |

### Explicit page images, 1,600 pixels

| Model | Effort | Trials | Strict passes | Response / PDF / deadline errors | Source checks | Median time | New-paper API cost |
|---|---|---:|---:|---|---:|---:|---:|
| 5.6-luna | low | 7 | 5/7 | 0 / 0 / 0 | 95.0% | 14.3s | $0.0086 |
| 5.6-luna | medium | 8 | 6/8 | 0 / 0 / 0 | 97.3% | 20.7s | $0.0094 |
| 5.6-terra | low | 7 | 4/7 | 0 / 0 / 0 | 98.3% | 20.0s | $0.0925 |
| 5.6-terra | medium | 6 | 2/6 | 0 / 0 / 0 | 97.9% | 21.8s | $0.0978 |
| 5.6-sol | low | 6 | 4/6 | 0 / 0 / 0 | 98.8% | 29.9s | $0.1775 |
| 5.6-sol | medium | 7 | 5/7 | 0 / 0 / 0 | 98.7% | 49.5s | $0.1983 |
| 6-astra | low | 8 | 7/8 | 0 / 0 / 1 | 100.0% | 25.8s | $0.4618 |
| 6-astra | medium | 7 | 5/7 | 0 / 0 / 2 | 100.0% | 33.2s | $0.5269 |

### Codex desktop runtime

| Requested model | Effort | Trials | Content + PDF passes | Response / source / PDF errors | Conditional source checks | Median captured time |
|---|---|---:|---:|---|---:|---:|
| 5.6-luna | low | 9 | 6/9 | 0 / 3 / 0 | 92.8% | 36.2s |
| 5.6-luna | medium | 9 | 6/9 | 0 / 3 / 0 | 95.9% | 60.2s |
| 5.6-luna | high | 3 | 2/3 | 0 / 1 / 0 | 93.0% | 99.8s |
| 5.6-luna | xhigh | 3 | 2/3 | 1 / 0 / 0 | Unscored | 130.6s |
| 5.6-luna | max | 3 | 2/3 | 1 / 0 / 0 | Unscored | 254.1s |
| 5.6-terra | low | 9 | 4/9 | 0 / 5 / 0 | 97.9% | 36.8s |
| 5.6-terra | medium | 9 | 4/9 | 0 / 5 / 0 | 98.1% | 42.0s |
| 5.6-terra | high | 3 | 2/3 | 0 / 1 / 0 | 99.0% | 70.8s |
| 5.6-terra | xhigh | 3 | 2/3 | 1 / 0 / 0 | Unscored | 96.2s |
| 5.6-terra | max | 3 | 2/3 | 1 / 0 / 0 | Unscored | 212.2s |
| 5.6-sol | low | 9 | 6/9 | 0 / 3 / 0 | 99.2% | 55.8s |
| 5.6-sol | medium | 9 | 6/9 | 0 / 3 / 0 | 98.9% | 67.2s |
| 5.6-sol | high | 3 | 2/3 | 0 / 1 / 0 | 99.0% | 83.5s |
| 5.6-sol | xhigh | 3 | 2/3 | 1 / 0 / 0 | Unscored | 117.0s |
| 5.6-sol | max | 3 | 2/3 | 1 / 0 / 0 | Unscored | 158.4s |
| 6-astra | low | 9 | 7/9 | 2 / 0 / 0 | 100.0% | 64.8s |
| 6-astra | medium | 9 | 7/9 | 2 / 0 / 0 | 100.0% | 68.3s |
| 6-astra | high | 3 | 2/3 | 1 / 0 / 0 | Unscored | 76.5s |
| 6-astra | xhigh | 3 | 2/3 | 1 / 0 / 0 | Unscored | 126.1s |
| 6-astra | max | 3 | 2/3 | 1 / 0 / 0 | Unscored | 217.6s |
