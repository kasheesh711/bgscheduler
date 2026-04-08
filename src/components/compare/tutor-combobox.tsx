"use client";

import { useState, useEffect } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface TutorOption {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  subjects: string[];
}

interface TutorComboboxProps {
  existingTutorGroupIds: string[];
  onAdd: (id: string, name: string) => void;
  disabled?: boolean;
}

export function TutorCombobox({ existingTutorGroupIds, onAdd, disabled }: TutorComboboxProps) {
  const [open, setOpen] = useState(false);
  const [tutors, setTutors] = useState<TutorOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || tutors.length > 0) return;
    setLoading(true);
    fetch("/api/tutors")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.tutors) setTutors(data.tutors);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, tutors.length]);

  const available = tutors.filter(
    (t) => !existingTutorGroupIds.includes(t.tutorGroupId),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            variant="outline"
            size="sm"
            className="border-dashed"
            disabled={disabled}
          >
            + Add tutor
          </Button>
        )}
      />
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tutors..." />
          <CommandList>
            <CommandEmpty>
              {loading ? "Loading tutors..." : "No tutors found."}
            </CommandEmpty>
            <CommandGroup>
              {available.map((t) => (
                <CommandItem
                  key={t.tutorGroupId}
                  value={t.displayName}
                  onSelect={() => {
                    onAdd(t.tutorGroupId, t.displayName);
                    setOpen(false);
                  }}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{t.displayName}</span>
                    <div className="flex gap-1 flex-wrap">
                      {t.supportedModes.map((m) => (
                        <Badge key={m} variant="secondary" className="text-[10px] px-1 py-0">
                          {m}
                        </Badge>
                      ))}
                      {t.subjects.slice(0, 3).map((s) => (
                        <Badge key={s} variant="outline" className="text-[10px] px-1 py-0">
                          {s}
                        </Badge>
                      ))}
                      {t.subjects.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{t.subjects.length - 3}
                        </span>
                      )}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
