"use client";

import type { ComponentProps, ReactNode } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadCsv, type CsvColumn } from "@/lib/sales-dashboard/csv";

interface CsvExportButtonProps<Row> {
  filename: string;
  rows: readonly Row[];
  columns: readonly CsvColumn<Row>[];
  children?: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}

export function CsvExportButton<Row>({
  filename,
  rows,
  columns,
  children = "Export CSV",
  disabled = false,
  title,
  className,
  variant = "outline",
  size = "sm",
}: CsvExportButtonProps<Row>) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={disabled || columns.length === 0}
      title={title}
      onClick={() => downloadCsv(filename, rows, columns)}
    >
      <Download className="size-3.5" />
      {children}
    </Button>
  );
}
