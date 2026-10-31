"use client";

import { SUBJECTS, type HiringConfig } from "@/lib/hiring/model";
import type { Command, HiringData } from "./dashboard";
import css from "./dashboard.module.css";

const WEIGHT_LABELS = {
  degree: "Degree relevance",
  subject: "Subject evidence",
  curriculum: "Curriculum experience",
  teaching: "Teaching experience",
  english: "English evidence",
  prestige: "University prestige",
};
type University = HiringConfig["universities"][number];
type Interviewer = HiringConfig["interviewers"][number];

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
}: {
  data: HiringData;
  config: HiringConfig;
  revision: number;
  setConfig: (config: HiringConfig) => void;
  busy: boolean;
  connect: () => void;
  command: Command;
}) {
  const total = Object.values(config.profileWeights).reduce((a, b) => a + b, 0);
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
        <p className={total === 100 ? css.railMeta : css.errorText}>
          Weight total: {total}/100. Current invitation threshold: {config.profileThreshold}/100.
        </p>
        <button
          type="button"
          className={css.primary}
          disabled={busy || total !== 100}
          onClick={() => command({ action: "settings", revision, config })}
        >
          Save rules and setup
        </button>
      </div>
      <div className={css.setupGrid}>
        <section className={css.setupSection}>
          <h2 className={css.panelTitle}>Screening rules</h2>
          <p className={css.panelLede}>
            Weights must total 100. Degree and subject evidence must meet the rule. Lower scores go to review.
          </p>
          <div className={css.weightBar} aria-hidden="true">
            {(Object.keys(WEIGHT_LABELS) as Array<keyof typeof WEIGHT_LABELS>).map((key) => (
              <span key={key} style={{ flexGrow: config.profileWeights[key] }} />
            ))}
          </div>
          {(Object.keys(WEIGHT_LABELS) as Array<keyof typeof WEIGHT_LABELS>).map((key) => (
            <label key={key} className={css.weightRow}>
              {WEIGHT_LABELS[key]}
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
          <Field label="SEEK job ID">
            <input
              className={css.input}
              value={config.seekJobId}
              onChange={(e) => setConfig({ ...config, seekJobId: e.target.value })}
            />
          </Field>
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
                  setInterviewer(i, { canonicalKey: e.target.value, email: tutor?.email ?? "" });
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
      </div>
    </div>
  );
}
