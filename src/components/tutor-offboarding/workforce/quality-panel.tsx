"use client";
import { useEffect, useRef, useState } from "react";
import type {
  WorkforceReport,
  ReviewedSubjectMapping,
} from "@/lib/tutor-offboarding/workforce/types";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Tag } from "../atoms";
import { bangkokTime } from "./presentation";
import { EvidenceIssueSummary } from "./evidence-issue-summary";
import {
  fetchMappingReview,
  saveMappingReview,
  WorkforceRequestError,
  type MappingReview,
  type UnmappedClass,
} from "./requests";
export function QualityContent({ report }: { report: WorkforceReport }) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Historical offered hours are unavailable before retained observations.
        Current schedules are not used to reconstruct past capacity or
        utilization. Opening Wise rosters are reconstructed from retained join
        dates and roster observations.
      </p>
      <div className="flex flex-wrap gap-2">
        <Tag
          tone={report.quality.completeness === "complete" ? "green" : "amber"}
        >
          {report.quality.completeness} supporting evidence
        </Tag>
        <span className="text-xs text-muted-foreground">
          Generated {bangkokTime(report.generatedAt)}
        </span>
      </div>
      {report.quality.issueCodes.map((issue, i) => (
        <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
          {issue.replaceAll("_", " ")}
        </p>
      ))}
      {report.quality.sourceCoverage.map((source, i) => (
        <Panel className="space-y-1 p-3 text-xs" key={`${source.source}-${i}`}>
          <h4 className="font-semibold [overflow-wrap:anywhere]">
            {source.source}
          </h4>
          <p>
            Requested {source.requestedFrom}–{source.requestedTo}
          </p>
          <p>
            Returned {source.returnedFrom ?? "Unavailable"}–
            {source.returnedTo ?? "Unavailable"} · {source.completeness}{" "}
            evidence{source.truncated ? " · Truncated" : ""}
          </p>
          <p>
            {source.recordsReturned} retained records · {source.pagesReturned}{" "}
            of {source.pagesRequested} requested pages
          </p>
          <p>
            Observed{" "}
            {source.observedAt
              ? bangkokTime(source.observedAt)
              : "Time unavailable"}
          </p>
          {source.issueCodes.map((code, index) => (
            <p key={index} className="text-muted-foreground">
              {code.replaceAll("_", " ")}
            </p>
          ))}
        </Panel>
      ))}
      {report.quality.exceptions.length ? (
        <div>
          <h4 className="mb-2 font-semibold">Evidence requiring review</h4>
          <EvidenceIssueSummary issues={report.quality.exceptions} />
        </div>
      ) : null}
    </div>
  );
}
export function QualityPanel({
  report,
  onRefresh,
}: {
  report: WorkforceReport;
  onRefresh: () => Promise<WorkforceReport>;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<MappingReview | null>(null);
  const [candidate, setCandidate] = useState<UnmappedClass | null>(null);
  const [subject, setSubject] = useState("");
  const [curriculum, setCurriculum] = useState("");
  const [level, setLevel] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const loadRef = useRef<AbortController | null>(null);
  const load = async () => {
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    setBusy(true);
    try {
      const next = await fetchMappingReview(report.query, controller.signal);
      if (controller.signal.aborted) return;
      setReview(next);
      setError(null);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Mapping evidence could not load.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    loadRef.current = controller;
    setBusy(true);
    void fetchMappingReview(report.query, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setReview(next);
          setError(null);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Mapping evidence could not load.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, report.query]);
  const choose = (row: UnmappedClass, mapping?: ReviewedSubjectMapping) => {
    setCandidate(row);
    setSubject(mapping?.subject ?? "");
    setCurriculum(mapping?.curriculum ?? "");
    setLevel(mapping?.level ?? "");
    setChecked(false);
    setSaved(false);
    setRefreshFailed(false);
    setError(null);
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await onRefresh();
      setRefreshFailed(false);
      setError(null);
    } catch (failure) {
      setRefreshFailed(true);
      setError(
        `Mapping saved, but the report could not refresh. ${failure instanceof Error ? failure.message : ""}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!candidate || !checked || !subject.trim() || saved) return;
    setBusy(true);
    setError(null);
    const existing = review?.mappings.find(
      (mapping) =>
        mapping.classId === candidate.classId &&
        mapping.sourceValue === candidate.sourceValue,
    );
    try {
      await saveMappingReview(
        {
          id: existing?.id,
          classId: candidate.classId,
          sourceValue: candidate.sourceValue,
          subject: subject.trim(),
          curriculum: curriculum.trim() || null,
          level: level.trim() || null,
          expectedRevision: existing?.revision ?? 0,
        },
        new AbortController().signal,
      );
      setSaved(true);
      setChecked(false);
      try {
        await onRefresh();
        setRefreshFailed(false);
      } catch (failure) {
        setRefreshFailed(true);
        setError(
          `Mapping saved, but the report could not refresh. ${failure instanceof Error ? failure.message : ""}`,
        );
      }
    } catch (failure) {
      if (failure instanceof WorkforceRequestError && failure.status === 409) {
        setError(
          "This mapping changed. Reload the review and check the current mapping before saving.",
        );
        setChecked(false);
      } else
        setError(
          failure instanceof Error
            ? failure.message
            : "Mapping could not be saved. Reload review before retrying.",
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Source quality &amp; subject review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-0 right-0 left-auto flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-[620px]">
          <div className="border-b p-5 pr-12">
            <DialogTitle>
              Source quality and academic subject review
            </DialogTitle>
            <DialogDescription className="mt-2">
              Review exact class labels. Saving a reviewed local mapping
              recalculates analytics; it does not change Wise classes.
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
            <QualityContent report={report} />
            <div className="space-y-3 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">Academic subject mappings</h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void load()}
                  disabled={busy}
                >
                  Reload review
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Course pricing/year categories and tutor qualifications do not
                establish a class’s academic subject.
              </p>
              {busy && !review ? (
                <p role="status">
                  Loading exact class labels and unmapped hours…
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-conflict">
                  {error}
                </p>
              ) : null}
              {review ? (
                <>
                  <div className="space-y-2">
                    {review.unmappedClasses.map((row, index) => (
                      <button
                        className="block w-full rounded border p-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-primary"
                        key={`${row.classId}-${index}`}
                        onClick={() => choose(row)}
                        disabled={busy}
                      >
                        <span className="block font-medium [overflow-wrap:anywhere]">
                          {row.sourceValue || "Empty source label"}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {row.bookedHours.toLocaleString()} unmapped booked
                          hours · {row.sessionsCount} classes · Class ID{" "}
                          {row.classId ?? "Unavailable; exact label alias"}
                        </span>
                      </button>
                    ))}
                    {review.unmappedClasses.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No unmapped class labels were returned for these
                        filters.
                      </p>
                    ) : null}
                  </div>
                  <details className="rounded border p-3">
                    <summary className="cursor-pointer text-sm focus-visible:outline-2">
                      Reviewed mappings ({review.mappings.length})
                    </summary>
                    <div className="mt-3 space-y-2">
                      {review.mappings.map((mapping) => (
                        <button
                          disabled={busy}
                          className="block w-full rounded border p-2 text-left text-xs focus-visible:outline-2"
                          key={mapping.id}
                          onClick={() =>
                            choose(
                              {
                                classId: mapping.classId,
                                sourceValue: mapping.sourceValue,
                                bookedHours: 0,
                                sessionsCount: 0,
                              },
                              mapping,
                            )
                          }
                        >
                          <span className="block [overflow-wrap:anywhere]">
                            {mapping.sourceValue} →{" "}
                            {[
                              mapping.subject,
                              mapping.curriculum,
                              mapping.level,
                            ]
                              .filter(Boolean)
                              .join(" / ")}
                          </span>
                          <span className="mt-1 block text-muted-foreground">
                            Reviewed{" "}
                            {mapping.reviewedAt
                              ? bangkokTime(mapping.reviewedAt)
                              : "Time unavailable"}{" "}
                            · Revision {mapping.revision}
                          </span>
                        </button>
                      ))}
                    </div>
                  </details>
                </>
              ) : null}
              {candidate ? (
                <form
                  className="space-y-3 rounded border bg-muted/20 p-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <h4 className="font-semibold [overflow-wrap:anywhere]">
                    Review: {candidate.sourceValue}
                  </h4>
                  <label className="block text-xs">
                    Academic subject
                    <Input
                      value={subject}
                      maxLength={200}
                      onChange={(e) => {
                        setSubject(e.target.value);
                        setChecked(false);
                      }}
                      disabled={busy || saved}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs">
                      Curriculum (optional)
                      <Input
                        value={curriculum}
                        onChange={(e) => {
                          setCurriculum(e.target.value);
                          setChecked(false);
                        }}
                        disabled={busy || saved}
                      />
                    </label>
                    <label className="text-xs">
                      Level (optional)
                      <Input
                        value={level}
                        onChange={(e) => {
                          setLevel(e.target.value);
                          setChecked(false);
                        }}
                        disabled={busy || saved}
                      />
                    </label>
                  </div>
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setChecked(e.target.checked)}
                      disabled={busy || saved}
                      className="mt-0.5"
                    />
                    I reviewed this exact class label and its academic subject.
                  </label>
                  {saved ? (
                    <p role="status" className="text-sm">
                      Mapping saved.
                      {refreshFailed
                        ? " Refresh the report before continuing."
                        : " Report refreshed."}
                    </p>
                  ) : null}
                  {refreshFailed ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void refresh()}
                      disabled={busy}
                    >
                      Retry report refresh
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      disabled={busy || saved || !checked || !subject.trim()}
                    >
                      {busy
                        ? "Saving reviewed mapping…"
                        : "Save reviewed mapping"}
                    </Button>
                  )}
                </form>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
