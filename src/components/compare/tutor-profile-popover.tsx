"use client";

import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CompareTutor } from "@/lib/search/types";

interface TutorProfilePopoverProps {
  tutor: CompareTutor;
  color: string;
  children: React.ReactNode;
}

export function TutorProfilePopover({ tutor, color, children }: TutorProfilePopoverProps) {
  const subjects = [...new Set(tutor.qualifications.map((q) => q.subject))];

  return (
    <Popover>
      <PopoverTrigger
        render={(props) => <span {...props}>{children}</span>}
        className="inline-flex cursor-pointer"
      />
      <PopoverContent side="bottom" className="w-64 p-4 space-y-3">
        <div>
          <div className="font-semibold" style={{ color }}>{tutor.displayName}</div>
          <div className="text-xs text-muted-foreground">{tutor.supportedModes.join(" / ")}</div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Weekly hours</div>
            <div className="font-semibold">{tutor.weeklyHoursBooked}h</div>
          </div>
          <div>
            <div className="text-muted-foreground">Students</div>
            <div className="font-semibold">{tutor.studentCount}</div>
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">Subjects</div>
          <div className="flex gap-1 flex-wrap">
            {subjects.map((s) => (
              <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
            ))}
          </div>
        </div>

        {tutor.dataIssues.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">Data issues</div>
            <Badge variant="destructive" className="text-[10px]">
              {tutor.dataIssues.length} issue{tutor.dataIssues.length > 1 ? "s" : ""}
            </Badge>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
