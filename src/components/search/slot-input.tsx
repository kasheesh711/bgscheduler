"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface SlotInputProps {
  onParse: (input: string) => void;
}

export function SlotInput({ onParse }: SlotInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onParse(value.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        placeholder='e.g. "Monday 11:00-12:00, Tuesday 15:00-17:00"'
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="flex-1"
      />
      <Button type="submit">Parse</Button>
    </form>
  );
}
