"use client";

import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { CountChip, Panel } from "./atoms";
import { BAND_LABEL, INBOX_BANDS } from "./format";
import { PersonRow } from "./person-row";

/** The review list: one panel per band, most likely first. */
export function Inbox({ rows, onOpen, onKeep, selectedKeys, onSelect, canRemove = false }: {
  rows: OffboardingPersonRow[]; onOpen: (key: string) => void; onKeep: (key: string) => void;
  selectedKeys?: ReadonlySet<string>; onSelect?: (key: string) => void; canRemove?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Panel>
        <p className="px-5 py-6 text-sm text-muted-foreground">
          Nobody to review. Every tutor on the Wise roster is teaching, new, staff, or marked still with us.
        </p>
      </Panel>
    );
  }
  return (
    <div className="space-y-4">
      {[...INBOX_BANDS, "active" as const].map((band) => {
        const group = rows.filter((row) => row.score.band === band && (band !== "active" || row.termination));
        if (group.length === 0) return null;
        return (
          <Panel key={band} data-band={band}>
            <header className="flex items-center gap-2 border-b px-5 py-3">
              <span className="text-[13px] font-semibold">{band === "active" ? "Marked for termination · recent teaching evidence" : BAND_LABEL[band]}</span>
              <CountChip>{group.length}</CountChip>
            </header>
            <ul>
              {group.map((row) => (
                <PersonRow key={row.signals.canonicalKey} row={row}
                  onOpen={() => onOpen(row.signals.canonicalKey)} onKeep={() => onKeep(row.signals.canonicalKey)}
                  selected={selectedKeys?.has(row.signals.canonicalKey)} canRemove={canRemove}
                  onSelect={onSelect ? () => onSelect(row.signals.canonicalKey) : undefined} />
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}
