"use client";

import { Button } from "@/components/ui/button";

const TUTOR_COLORS = ["#3b82f6", "#f472b6", "#a78bfa"];

interface TutorChip {
  tutorGroupId: string;
  displayName: string;
  color: string;
}

interface TutorSelectorProps {
  tutors: TutorChip[];
  onRemove: (id: string) => void;
  onOpenDiscovery: () => void;
}

export function TutorSelector({ tutors, onRemove, onOpenDiscovery }: TutorSelectorProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {tutors.map((t) => (
        <div
          key={t.tutorGroupId}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
          style={{ borderColor: t.color }}
        >
          <div className="h-2 w-2 rounded-full" style={{ background: t.color }} />
          <span>{t.displayName}</span>
          <button
            onClick={() => onRemove(t.tutorGroupId)}
            className="text-muted-foreground hover:text-foreground text-xs ml-1"
          >
            ✕
          </button>
        </div>
      ))}
      {tutors.length < 3 && (
        <Button variant="outline" size="sm" onClick={onOpenDiscovery} className="border-dashed">
          + Add tutor
        </Button>
      )}
      <span className="text-xs text-muted-foreground ml-auto">
        {tutors.length}/3 tutors
      </span>
    </div>
  );
}

export { TUTOR_COLORS };
export type { TutorChip };
