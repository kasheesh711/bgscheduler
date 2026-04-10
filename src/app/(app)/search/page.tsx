"use client";

import { Suspense } from "react";
import { SearchWorkspace } from "@/components/search/search-workspace";

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      }
    >
      <SearchWorkspace />
    </Suspense>
  );
}
