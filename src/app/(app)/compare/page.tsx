"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";

function CompareRedirectInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const tutors = searchParams.get("tutors");
    if (tutors) {
      router.replace(`/search?tutors=${tutors}`);
    } else {
      router.replace("/search");
    }
  }, [searchParams, router]);

  return null;
}

export default function CompareRedirect() {
  return (
    <Suspense>
      <CompareRedirectInner />
    </Suspense>
  );
}
