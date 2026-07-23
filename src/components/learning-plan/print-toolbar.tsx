"use client";

import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";

import { Button } from "@/components/ui/button";

export function PrintToolbar() {
  async function handlePrint() {
    // Prevent PDFs from capturing fallback typefaces.
    await document.fonts.ready;
    window.print();
  }

  return (
    <div className="print-hidden sticky top-0 z-10 border-b border-begifted-neutral-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-4 px-6 py-3">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/learning-plans" />}
        >
          <ArrowLeft data-icon="inline-start" />
          Back to form
        </Button>
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-begifted-neutral-400 sm:block">
            Choose “Save as PDF” in the print dialog · best in Chrome
          </p>
          <Button
            size="sm"
            onClick={handlePrint}
            className="rounded-full bg-begifted-orange-500 px-5 font-semibold text-white hover:bg-begifted-orange-600"
          >
            <Download data-icon="inline-start" />
            Download PDF
          </Button>
        </div>
      </div>
    </div>
  );
}
