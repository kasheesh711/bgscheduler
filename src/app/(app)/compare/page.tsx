import { redirect } from "next/navigation";

export default async function CompareRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tutors?: string }>;
}) {
  const params = await searchParams;
  const tutors = params.tutors;
  if (tutors) {
    redirect(`/search?tutors=${tutors}`);
  }
  redirect("/search");
}
