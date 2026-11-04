"use client";

import { localDate, SUBJECTS, type HiringConfig } from "@/lib/hiring/model";
import {
  daysOf,
  fullPriority,
  HEAD_DAYS,
  hasSavedHours,
  LIMIT_FIELDS,
  minutesToTime,
  movePriority,
  PRE_SCREEN_WEIGHT_LABELS,
  PROFILE_WEIGHT_LABELS,
  sendingNotice,
  setHiring,
  setLimit,
  setWorkRightsAccepted,
  settingsProblems,
  startsSending,
  timeToMinutes,
  unsavedHeadDays,
  workRightsRows,
  type LimitField,
} from "@/lib/hiring/rules";
import type { Command, HiringData } from "./dashboard";
import { PaperLibrary, PassRules } from "./assessment-setup";
import css from "./dashboard.module.css";

const dayText = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
type University = HiringConfig["universities"][number];
type Interviewer = HiringConfig["interviewers"][number];

function LimitRows({ funnel, config, setConfig }: { funnel: LimitField["funnel"]; config: HiringConfig; setConfig: (c: HiringConfig) => void }) {
  return (
    <>
      {LIMIT_FIELDS.filter((f) => f.funnel === funnel).map((f) => (
        <label key={f.id} className={css.weightRow}>
          {f.label}
          <input
            className={css.numberInput}
            type="number"
            min={f.min}
            max={f.max}
            value={f.get(config)}
            onChange={(e) => setConfig(setLimit(config, f.id, Number(e.target.value)))}
          />
        </label>
      ))}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={css.fieldLabel}>
      {label}
      {children}
    </label>
  );
}

export function SetupPanel({
  data,
  config,
  revision,
  setConfig,
  busy,
  connect,
  command,
  dayDrafts,
  setDayDrafts,
  error,
  notice,
}: {
  data: HiringData;
  config: HiringConfig;
  revision: number;
  setConfig: (config: HiringConfig) => void;
  busy: boolean;
  connect: () => void;
  command: Command;
  /** Head ticks not saved yet. The dashboard holds them, so a tab switch does not drop them. */
  dayDrafts: Record<string, boolean[]>;
  setDayDrafts: (update: (drafts: Record<string, boolean[]>) => Record<string, boolean[]>) => void;
  /** The last save result, shown beside the Save button so it is in view at any width. */
  error: string;
  notice: string;
}) {
  const total = Object.values(config.profileWeights).reduce((a, b) => a + b, 0);
  const preTotal = Object.values(config.preScreenWeights).reduce((a, b) => a + b, 0);
  const problems = settingsProblems(config);
  const sending = startsSending(data.config, config);
  const today = localDate(new Date());
  const unsavedHeads = unsavedHeadDays(
    dayDrafts,
    data.heads,
    Object.fromEntries(data.tutors.map((t) => [t.canonicalKey, t.name])),
  );
  const priority = fullPriority(config.subjectPriority);
  const setUniversity = (index: number, patch: Partial<University>) =>
    setConfig({
      ...config,
      universities: config.universities.map((u, i) => (i === index ? { ...u, ...patch } : u)),
    });
  const setInterviewer = (index: number, patch: Partial<Interviewer>) =>
    setConfig({
      ...config,
      interviewers: config.interviewers.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    });

  return (
    <div className={css.setup}>
      <div className={css.setupBar}>
        <div>
          <p className={total === 100 ? css.railMeta : css.errorText}>
            Weight total: {total}/100. Current invitation threshold: {config.profileThreshold}/100.
          </p>
          {data.configProblems.length > 0 && (
            <p className={css.errorText} role="alert">
              The saved rules have a problem. {data.configProblems.join(" ")} Fix it here and save. Until then the worker stops.
            </p>
          )}
          {unsavedHeads.length > 0 && (
            <p className={css.warnWord} role="alert">
              Head days not saved: {unsavedHeads.join(", ")}
            </p>
          )}
          {error && (
            <p className={css.errorText} role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className={css.goodWord} role="status">
              {notice}
            </p>
          )}
          {problems.map((problem) => (
            <p key={problem} className={css.errorText}>
              {problem}
            </p>
          ))}
        </div>
        <button
          type="button"
          className={css.primary}
          disabled={busy || total !== 100 || problems.length > 0}
          onClick={() => command({ action: "settings", revision, config })}
        >
          {sending ? "Save and start sending" : "Save rules and setup"}
        </button>
      </div>
      <div className={css.setupGrid}>
        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Screening rules</h2>
          <p className={css.panelLede}>
            Weights must total 100. A candidate needs this score, an accepted work-rights answer and a hiring subject to get the form. A candidate who misses only these waits at New, and a change here takes effect on the next cycle. A degree marked not met, no supported subject, no email or earlier contact go to review.
          </p>
          <div className={css.weightBar} aria-hidden="true">
            {(Object.keys(PROFILE_WEIGHT_LABELS) as Array<keyof typeof PROFILE_WEIGHT_LABELS>).map((key) => (
              <span key={key} style={{ flexGrow: config.profileWeights[key] }} />
            ))}
          </div>
          {(Object.keys(PROFILE_WEIGHT_LABELS) as Array<keyof typeof PROFILE_WEIGHT_LABELS>).map((key) => (
            <label key={key} className={css.weightRow}>
              {PROFILE_WEIGHT_LABELS[key]}
              <input
                className={css.numberInput}
                type="number"
                min={0}
                max={100}
                value={config.profileWeights[key]}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    profileWeights: { ...config.profileWeights, [key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
          <label className={`${css.weightRow} ${css.weightTotal}`}>
            Invitation threshold
            <input
              className={css.numberInput}
              type="number"
              min={0}
              max={100}
              value={config.profileThreshold}
              onChange={(e) => setConfig({ ...config, profileThreshold: Number(e.target.value) })}
            />
          </label>
          <label className={css.weightRow}>
            HR call score (blank: no calls)
            <input
              className={css.numberInput}
              type="number"
              min={0}
              max={100}
              value={config.callThreshold ?? ""}
              onChange={(e) => setConfig({ ...config, callThreshold: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
          <p className={css.panelLede}>
            {config.callThreshold === null
              ? "Every candidate who passes gets the form without a call."
              : `A candidate at or above ${config.callThreshold} gets the form only after HR records a good call on the Calls tab.`}
          </p>
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Automation</h2>
          <p className={css.panelLede}>
            Weekend and weekday-after-15:00 teaching availability are required.
          </p>
          <div className={css.checkList}>
            <label>
              <input
                type="checkbox"
                checked={config.rubricApproved}
                onChange={(e) => setConfig({ ...config, rubricApproved: e.target.checked })}
              />
              Rules approved
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              />
              Enable automation
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.deliveryEnabled}
                onChange={(e) => setConfig({ ...config, deliveryEnabled: e.target.checked })}
              />
              Enable messages
            </label>
          </div>
          {sending && (
            <p className={css.warnWord} role="note">
              {sendingNotice(config)}
            </p>
          )}
          {!data.writeGate && <p className={css.warnWord}>Production write gate is off.</p>}
          <h2 className={css.panelTitle}>Connections</h2>
          <p className={css.statusRow}>
            <span>Google</span>
            <span className={data.google.connected ? css.goodWord : css.warnWord}>
              {data.google.connected ? "Calendar and Sheets connected" : "Calendar consent needed"}
            </span>
          </p>
          <button type="button" className={css.secondary} disabled={busy} onClick={connect}>
            Connect Google
          </button>
          <Field label="Google organizer email">
            <input
              className={css.input}
              type="email"
              value={config.connectedEmail}
              onChange={(e) => setConfig({ ...config, connectedEmail: e.target.value })}
            />
          </Field>
          <h3 className={css.panelTitle}>SEEK campaigns</h3>
          <p className={css.panelLede}>
            The worker reads each active job ad. An inactive one keeps its candidates and is not read. The job ID is the
            number after <code>jobid=</code> in the SEEK candidates address.
          </p>
          {config.seekJobs.map((job, i) => {
            const setJob = (patch: Partial<typeof job>) =>
              setConfig({ ...config, seekJobs: config.seekJobs.map((j, k) => (k === i ? { ...j, ...patch } : j)) });
            return (
              <fieldset className={css.interviewerRow} key={i}>
                <legend className="sr-only">Campaign {i + 1}</legend>
                <input
                  className={css.input}
                  aria-label={`Campaign ${i + 1} SEEK job ID`}
                  inputMode="numeric"
                  value={job.jobId}
                  onChange={(e) => setJob({ jobId: e.target.value.trim() })}
                />
                <input
                  className={css.input}
                  aria-label={`Campaign ${i + 1} name`}
                  value={job.label}
                  onChange={(e) => setJob({ label: e.target.value })}
                />
                <button
                  type="button"
                  className={css.inlineLink}
                  disabled={config.seekJobs.length === 1}
                  onClick={() => setConfig({ ...config, seekJobs: config.seekJobs.filter((_, k) => k !== i) })}
                >
                  Remove
                </button>
                <div className={css.subjectChecks}>
                  <label>
                    <input type="checkbox" checked={job.active} onChange={(e) => setJob({ active: e.target.checked })} />
                    Active: the worker reads this job
                  </label>
                </div>
              </fieldset>
            );
          })}
          {config.seekJobs.length < 5 && (
            <button
              type="button"
              className={css.secondary}
              onClick={() =>
                setConfig({ ...config, seekJobs: [...config.seekJobs, { jobId: "", label: "New campaign", active: true }] })
              }
            >
              Add campaign
            </button>
          )}
          <Field label="Office location">
            <input
              className={css.input}
              value={config.location}
              onChange={(e) => setConfig({ ...config, location: e.target.value })}
            />
          </Field>
          <Field label="Closed dates (YYYY-MM-DD, separated by commas)">
            <input
              className={css.input}
              value={config.holidays.join(", ")}
              onChange={(e) =>
                setConfig({
                  ...config,
                  holidays: e.target.value.split(",").map((v) => v.trim()).filter(Boolean),
                })
              }
            />
          </Field>
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Pre-screen email rules</h2>
          <p className={css.panelLede}>
            Change a number here and the meters on Pipeline change. The profile score a candidate needs to get the form is the invitation threshold under Screening rules.
          </p>
          <LimitRows funnel="pre" config={config} setConfig={setConfig} />
          <p className={css.railMeta}>The pass score only controls automatic onsite invitations. The pre-screen form is not affected.</p>
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Onsite invitation rules</h2>
          {config.preScreenThreshold === null ? (
            <p className={css.warnWord}>No pass score is set. Automatic onsite invitations cannot run until you set one.</p>
          ) : (
            <p className={css.panelLede}>A reply at or above the pass score, with every hard stop met, gets a booking link.</p>
          )}
          <label className={css.weightRow}>
            Pre-screen pass score
            <input
              className={css.numberInput}
              type="number"
              min={0}
              max={100}
              value={config.preScreenThreshold ?? ""}
              onChange={(e) =>
                setConfig({ ...config, preScreenThreshold: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
          </label>
          <LimitRows funnel="on" config={config} setConfig={setConfig} />
          <label className={css.weightRow}>
            Visits start no earlier than
            <input
              className={css.numberInput}
              type="time"
              value={minutesToTime(config.visitStartMinute)}
              onChange={(e) => {
                const minute = timeToMinutes(e.target.value);
                if (minute !== null) setConfig({ ...config, visitStartMinute: minute });
              }}
            />
          </label>
          <label className={css.weightRow}>
            Visits end no later than
            <input
              className={css.numberInput}
              type="time"
              value={minutesToTime(config.visitEndMinute)}
              onChange={(e) => {
                const minute = timeToMinutes(e.target.value);
                if (minute !== null) setConfig({ ...config, visitEndMinute: minute });
              }}
            />
          </label>
          <p className={css.railMeta}>
            Cancel and no-show free the open places. They do not free the weekly count, because the email has already gone. To send more this week, raise the number.
          </p>
          <p className={css.railMeta}>
            The booking link lasts 30 days, so the link can expire after 30 days at most. Candidates can move a booking once, up to 24 hours before the visit. Later changes go through staff.
          </p>
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Pre-screen score weights</h2>
          <p className={css.panelLede}>Separate from the profile weights. The total must be 100.</p>
          {(Object.keys(PRE_SCREEN_WEIGHT_LABELS) as Array<keyof typeof PRE_SCREEN_WEIGHT_LABELS>).map((key) => (
            <label key={key} className={css.weightRow}>
              {PRE_SCREEN_WEIGHT_LABELS[key]}
              <input
                className={css.numberInput}
                type="number"
                min={0}
                max={100}
                value={config.preScreenWeights[key]}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    preScreenWeights: { ...config.preScreenWeights, [key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
          <p className={preTotal === 100 ? css.goodWord : css.errorText}>Total {preTotal} of 100</p>
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Hard stops</h2>
          <p className={css.panelLede}>A candidate who fails one goes to review, even with a high score. No rejection is sent.</p>
          <div className={css.checkList}>
            {[
              "Completed bachelor's degree or higher",
              "English: C1 for English subjects, B2 for others. “Native” counts as C2.",
              "A weekend day and a weekday after 15:00",
            ].map((text) => (
              <label key={text}>
                <input type="checkbox" checked disabled readOnly />
                {text}
              </label>
            ))}
          </div>
          <h3 className={css.inspectorHeading}>Accepted SEEK work-rights answers</h3>
          <div className={css.checkList}>
            {workRightsRows(config).map((row) => (
              <label key={row.answer}>
                <input
                  type="checkbox"
                  checked={row.accepted}
                  onChange={(e) => setConfig(setWorkRightsAccepted(config, row.answer, e.target.checked))}
                />
                <span>{row.answer}</span>
              </label>
            ))}
          </div>
          <p className={css.railMeta}>A new answer from SEEK appears here, not accepted, until you tick it.</p>
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Subject priority</h2>
          <p className={css.panelLede}>Top subjects go first in both queues. Untick a subject to stop hiring for it.</p>
          {priority.map((row, i) => (
            <div key={row.subject} className={css.priorityRow}>
              <span className={`${css.num} ${css.mutedCell}`}>{i + 1}</span>
              <label>
                <input
                  type="checkbox"
                  checked={row.hiring}
                  aria-label={`Hiring ${row.subject}`}
                  onChange={(e) => setConfig({ ...config, subjectPriority: setHiring(priority, i, e.target.checked) })}
                />
                {row.subject}
                {!row.hiring && <span className={css.railMeta}> Not hiring</span>}
              </label>
              <button
                type="button"
                className={css.secondary}
                aria-label={`Move ${row.subject} up`}
                disabled={i === 0}
                onClick={() => setConfig({ ...config, subjectPriority: movePriority(priority, i, -1) })}
              >
                Up
              </button>
              <button
                type="button"
                className={css.secondary}
                aria-label={`Move ${row.subject} down`}
                disabled={i === priority.length - 1}
                onClick={() => setConfig({ ...config, subjectPriority: movePriority(priority, i, 1) })}
              >
                Down
              </button>
            </div>
          ))}
        </section>

        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Head office days</h2>
          <p className={css.panelLede}>
            Visits need a head who is in the office for the mock hour. Tick the days, then save that head.
          </p>
          <p className={css.warnWord}>
            This also changes Tutor Attendance. For a head enrolled there, a saved change starts tomorrow.
          </p>
          {config.interviewers
            .filter((head) => head.canonicalKey)
            .map((head) => {
              const key = head.canonicalKey;
              const state = data.heads[key];
              const inSaved = data.config.interviewers.some((i) => i.canonicalKey === key);
              const saved = daysOf(state?.week);
              const ticks = dayDrafts[key] ?? saved;
              const dirty = ticks.some((on, i) => on !== saved[i]);
              const name = data.tutors.find((t) => t.canonicalKey === key)?.name ?? key;
              const ended = state?.state === "ended";
              return (
                <div key={key} className={css.headDayRow}>
                  <div>
                    <strong>{name}</strong>
                    <span className={css.railMeta}>
                      {" "}
                      {state?.state === "enrolled" || ended ? "Tutor Attendance schedule" : "Hiring settings only"}
                    </span>
                  </div>
                  {inSaved && !ended ? (
                    <div className={css.dayChecks}>
                      {HEAD_DAYS.map((day, i) => (
                        <label key={day}>
                          {day}
                          <input
                            type="checkbox"
                            checked={ticks[i]}
                            aria-label={`${name} ${day}`}
                            onChange={(e) => setDayDrafts((d) => ({ ...d, [key]: ticks.map((on, j) => (j === i ? e.target.checked : on)) }))}
                          />
                        </label>
                      ))}
                      <button
                        type="button"
                        className={css.secondary}
                        disabled={busy || !dirty}
                        onClick={async () => {
                          if (await command({ action: "head_days", key, days: ticks, revision }))
                            setDayDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
                        }}
                      >
                        {state?.state === "enrolled" ? "Save days to Tutor Attendance" : "Save days"}
                      </button>
                    </div>
                  ) : (
                    <p className={css.railMeta}>
                      {ended
                        ? "Their Tutor Attendance enrollment has ended, so they get no visit times. Switch it back on in Tutor Attendance."
                        : "Save the rules and setup first, then set days."}
                    </p>
                  )}
                  {inSaved && !ended && !hasSavedHours(state?.week) && (
                    <p className={css.warnWord}>No saved hours: this head gets no visit times.</p>
                  )}
                  {state?.from && state.from > today && (
                    <p className={css.railMeta}>The saved change starts {dayText(state.from)}.</p>
                  )}
                </div>
              );
            })}
          <p className={css.railMeta}>Hours stay as saved. A day you add gets 10:00 to 16:00. A visit also needs a free Wise hour for the mock.</p>
          <h3 className={css.inspectorHeading}>Résumé files</h3>
          <label className={css.weightRow}>
            Delete after months with no activity
            <input
              className={css.numberInput}
              type="number"
              min={1}
              max={120}
              value={config.resumeRetentionMonths}
              onChange={(e) => setConfig({ ...config, resumeRetentionMonths: Number(e.target.value) })}
            />
          </label>
          <p className={css.railMeta}>Files past this age are deleted for good at the next nightly run. Lowering this number can delete many files.</p>
        </section>

        <section className={`${css.setupSection} ${css.setupWide}`}>
          <h2 className={css.panelTitle}>Mock interviewers</h2>
          <p className={css.panelLede}>
            Give Peat and Ek both Mathematics and Physics. Only a registered, enabled tutor LINE group can receive a booking.
          </p>
          {config.interviewers.map((interviewer, i) => (
            <fieldset className={css.interviewerRow} key={i}>
              <legend className="sr-only">Interviewer {i + 1}</legend>
              <select
                aria-label={`Interviewer ${i + 1}`}
                className={css.input}
                value={interviewer.canonicalKey}
                onChange={(e) => {
                  const tutor = data.tutors.find((t) => t.canonicalKey === e.target.value);
                  // Hours saved for the old tutor are not the new tutor's.
                  setInterviewer(i, { canonicalKey: e.target.value, email: tutor?.email ?? "", fallbackWeek: undefined });
                }}
              >
                <option value="">Choose tutor</option>
                {data.tutors.map((t) => (
                  <option key={t.canonicalKey} value={t.canonicalKey}>
                    {t.name}
                    {t.lineReady ? "" : " — LINE needs setup"}
                  </option>
                ))}
              </select>
              <input
                className={css.input}
                aria-label={`Interviewer ${i + 1} email`}
                type="email"
                value={interviewer.email}
                onChange={(e) => setInterviewer(i, { email: e.target.value })}
              />
              <button
                type="button"
                className={css.inlineLink}
                onClick={() =>
                  setConfig({ ...config, interviewers: config.interviewers.filter((_, j) => i !== j) })
                }
              >
                Remove
              </button>
              <div className={css.subjectChecks}>
                {SUBJECTS.map((subject) => (
                  <label key={subject}>
                    <input
                      type="checkbox"
                      checked={interviewer.subjects.includes(subject)}
                      onChange={(e) =>
                        setInterviewer(i, {
                          subjects: e.target.checked
                            ? [...interviewer.subjects, subject]
                            : interviewer.subjects.filter((s) => s !== subject),
                        })
                      }
                    />
                    {subject}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className={css.secondary}
            onClick={() =>
              setConfig({
                ...config,
                interviewers: [...config.interviewers, { canonicalKey: "", email: "", subjects: [] }],
              })
            }
          >
            Add interviewer
          </button>
        </section>

        <section className={`${css.setupSection} ${css.setupFull}`}>
          <h2 className={css.panelTitle}>University prestige rules and reference data</h2>
          <p className={css.panelLede}>
            US/UK universities receive 40% of this category before ranking points. Global ranks 1–10 add 60%; 11–50 add 50%; 51–100 add 40%; 101–200 add 30%; 201–500 add 20%; 501–1000 add 10%. Chulalongkorn, Thammasat, and Mahidol receive 60%. Use overall US News Best Global Universities ranks from the stated edition. An unverified rank receives no ranking points.
          </p>
          <div className={css.universityScroll}>
            <table className={css.universityTable}>
              <thead>
                <tr>
                  <th>University</th>
                  <th>Country code (US, GB, TH…)</th>
                  <th>Overall global rank (blank if unverified)</th>
                  <th>Edition</th>
                  <th>Source URL</th>
                  <th>Other names (separate with semicolons)</th>
                  <th><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {config.universities.map((u, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        className={css.input}
                        aria-label={`University ${i + 1}`}
                        value={u.name}
                        onChange={(e) => setUniversity(i, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className={css.input}
                        aria-label={`University ${i + 1} country code`}
                        value={u.country}
                        maxLength={2}
                        onChange={(e) => setUniversity(i, { country: e.target.value.toUpperCase() })}
                      />
                    </td>
                    <td>
                      <input
                        className={css.input}
                        aria-label={`University ${i + 1} overall global rank`}
                        type="number"
                        min={1}
                        value={u.rank ?? ""}
                        onChange={(e) =>
                          setUniversity(i, { rank: e.target.value ? Number(e.target.value) : null })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className={css.input}
                        aria-label={`University ${i + 1} edition`}
                        value={u.edition}
                        onChange={(e) => setUniversity(i, { edition: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className={css.input}
                        aria-label={`University ${i + 1} source URL`}
                        type="url"
                        value={u.sourceUrl}
                        onChange={(e) => setUniversity(i, { sourceUrl: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className={css.input}
                        aria-label={`University ${i + 1} other names`}
                        value={u.aliases.join("; ")}
                        onChange={(e) =>
                          setUniversity(i, {
                            aliases: e.target.value.split(";").map((a) => a.trim()).filter(Boolean),
                          })
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className={css.inlineLink}
                        aria-label={`Remove university ${i + 1}`}
                        onClick={() =>
                          setConfig({
                            ...config,
                            universities: config.universities.filter((_, j) => j !== i),
                          })
                        }
                      >
                        Remove university
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={css.secondary}
            onClick={() =>
              setConfig({
                ...config,
                universities: [
                  ...config.universities,
                  { name: "", country: "", rank: null, edition: "2026-2027", sourceUrl: "", aliases: [] },
                ],
              })
            }
          >
            Add verified university
          </button>
        </section>
        <PassRules config={config} setConfig={setConfig} />
        <PaperLibrary data={data} command={command} busy={busy} />
      </div>
    </div>
  );
}
