import { Suspense } from "react";
import { getFilterOptions } from "@/lib/data/filters";
import { getTutorList } from "@/lib/data/tutors";
import { SearchWorkspace } from "@/components/search/search-workspace";
import { SearchSkeleton } from "@/components/skeletons/search-skeleton";

export default async function SearchPage() {
  const filterOptions = await getFilterOptions();
  const tutorList = await getTutorList();

  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchWorkspace
        filterOptions={filterOptions}
        tutorList={tutorList}
      />
    </Suspense>
  );
}
