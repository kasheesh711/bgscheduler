"use client";

// ----------------------------------------------------------------------------
// Self-report sections list (design §5.2, PRD CM-121) — one card per guided
// section with its review-state chip and answered/total completion meter;
// tapping a card opens the SectionForm for that section and a back affordance
// returns to the list (closing refreshes the server tree so chips reflect
// autosaved edits, including a submitted → draft revert).
//
// The page fetches the FULL section states (getSectionState per key) so
// completion is computable without a client fetch; role/variant gates live in
// SectionForm — this list is pure presentation + selection.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AdmissionsSectionStateDto } from "@/lib/admissions/sections";
import type { CaseRole } from "@/lib/admissions/types";
import {
  SECTION_STATE_CLASSES,
  SECTION_STATE_LABELS,
  SectionForm,
  computeSectionCompletion,
  type SectionFormVariant,
} from "./section-form";

// ── List ────────────────────────────────────────────────────────────────

/** Props for SectionsList — full section states are server-fetched. */
export interface SectionsListProps {
  caseId: string;
  /** Full states (definition + payload + review state), display order. */
  sections: AdmissionsSectionStateDto[];
  viewerRole: CaseRole;
  variant: SectionFormVariant;
}

/**
 * Section cards with state chips + completion (CM-121); selecting a card
 * renders the guided SectionForm in place, and closing it returns to the
 * list with a router.refresh() so the card chips pick up any state change.
 */
export function SectionsList({ caseId, sections, viewerRole, variant }: SectionsListProps) {
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    setOpenKey(null);
    router.refresh();
  }, [router]);

  const openSection = sections.find((section) => section.sectionKey === openKey) ?? null;
  if (openSection) {
    return (
      <SectionForm
        caseId={caseId}
        section={openSection}
        viewerRole={viewerRole}
        variant={variant}
        onClose={handleClose}
      />
    );
  }

  return (
    <Card data-testid="sections-list">
      <CardHeader>
        <CardTitle>Self-report sections</CardTitle>
        <CardDescription>
          Guided forms your counselor uses to get to know you (CM-121).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sections.length > 0 ? (
          <ul className="space-y-2">
            {sections.map((section) => {
              const completion = computeSectionCompletion(section.definition, section.payload);
              return (
                <li key={section.sectionKey}>
                  <button
                    type="button"
                    data-testid={`section-card-${section.sectionKey}`}
                    className="w-full min-h-11 space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => setOpenKey(section.sectionKey)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {section.definition.title}
                      </span>
                      <Badge className={SECTION_STATE_CLASSES[section.state]}>
                        {SECTION_STATE_LABELS[section.state]}
                      </Badge>
                      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {section.definition.description}
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                      >
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${completion.percent}%` }}
                        />
                      </span>
                      <span
                        data-testid={`section-completion-${section.sectionKey}`}
                        className="text-xs tabular-nums text-muted-foreground"
                      >
                        {completion.answered}/{completion.total} answered
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sections available.</p>
        )}
      </CardContent>
    </Card>
  );
}
