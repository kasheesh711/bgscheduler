"use client";

import { CheckCircle2, Link2, Loader2, Search, UserPlus, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { StudentDirectoryRow, StudentLink } from "./types";
import { StudentStateBadges } from "./status-badges";

export function StudentLinkCommand({
  open,
  onOpenChange,
  labelInput,
  onLabelInputChange,
  onParseLabel,
  studentSearch,
  onStudentSearchChange,
  studentResults,
  links,
  onAddStudentLink,
  onUpdateLink,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labelInput: string;
  onLabelInputChange: (value: string) => void;
  onParseLabel: () => void;
  studentSearch: string;
  onStudentSearchChange: (value: string) => void;
  studentResults: StudentDirectoryRow[];
  links: StudentLink[];
  onAddStudentLink: (studentKey: string) => void;
  onUpdateLink: (linkId: string, action: "verify" | "reject") => void;
  busy: string | null;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <Button {...props} type="button" variant="outline" size="sm">
            <UserPlus />
            Link student
          </Button>
        )}
      />
      <PopoverContent align="end" side="bottom" className="w-[min(520px,calc(100vw-2rem))] p-0">
        <div className="border-b border-border p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <UserPlus className="size-4 text-primary" />
            Link student to LINE parent
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Paste a LINE label or search the current Wise snapshot. Verification still stays admin-controlled.
          </p>
        </div>

        <div className="space-y-3 p-3">
          <div className="rounded-lg border border-border bg-background p-2.5">
            <div className="flex gap-2">
              <Input
                value={labelInput}
                onChange={(event) => onLabelInputChange(event.target.value)}
                placeholder="Paste LINE label or helper text"
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onParseLabel}
                disabled={Boolean(busy) || !labelInput.trim()}
              >
                {busy === "label" ? <Loader2 className="animate-spin" /> : <Link2 />}
                Parse
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background p-2.5">
            <div className="flex items-center gap-2">
              <Search className="size-4 text-muted-foreground" />
              <Input
                value={studentSearch}
                onChange={(event) => onStudentSearchChange(event.target.value)}
                placeholder="Search students"
                className="h-8"
              />
            </div>

            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
              {studentResults.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  Search by student code, nickname code, student name, or parent name. Inactive Wise students are included.
                </div>
              ) : studentResults.map((student) => (
                <div
                  key={student.studentKey}
                  className="rounded-md border border-border bg-card p-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {student.studentName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {student.studentKey} / {student.parentName || "No parent"}
                        {student.matchType ? ` / ${student.matchType}` : ""}
                      </div>
                      <StudentStateBadges
                        activated={student.activated}
                        hasFutureSessions={student.hasFutureSessions}
                        hasLivePackage={student.hasLivePackage}
                      />
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => onAddStudentLink(student.studentKey)}
                      disabled={Boolean(busy)}
                    >
                      {busy === `add-${student.studentKey}` ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <CheckCircle2 />
                      )}
                      Add
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Current contact links
              </div>
              <Badge variant="outline">{links.length}</Badge>
            </div>
            {links.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No student links exist for this LINE contact yet.
              </div>
            ) : (
              <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                {links.map((link) => (
                  <div key={link.id} className="rounded-md border border-border bg-card p-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {link.studentName}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {link.studentKey} / Parent: {link.parentName || "n/a"}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <Badge
                            variant={link.status === "verified"
                              ? "default"
                              : link.status === "rejected"
                                ? "destructive"
                                : "outline"}
                          >
                            {link.status}
                          </Badge>
                        </div>
                        <StudentStateBadges
                          activated={link.currentStudentActivated}
                          hasFutureSessions={link.currentStudentHasFutureSessions}
                          hasLivePackage={link.currentStudentHasLivePackage}
                        />
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="outline"
                          onClick={() => onUpdateLink(link.id, "verify")}
                          disabled={Boolean(busy) || link.status === "verified"}
                          aria-label={`Verify ${link.studentKey}`}
                        >
                          {busy === `link-${link.id}` ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <CheckCircle2 />
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="destructive"
                          onClick={() => onUpdateLink(link.id, "reject")}
                          disabled={Boolean(busy) || link.status === "rejected"}
                          aria-label={`Reject ${link.studentKey}`}
                        >
                          <XCircle />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
