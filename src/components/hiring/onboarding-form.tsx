"use client";

import { useState, type FormEvent } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const fields = [
  { name: "legalName", label: "Legal full name", type: "text", autoComplete: "name", max: 160 },
  { name: "preferredName", label: "Preferred tutor name", type: "text", autoComplete: "nickname", max: 60 },
  { name: "phone", label: "Phone number", type: "tel", autoComplete: "tel", max: 32 },
  { name: "onsiteEmail", label: "Email for Onsite Wise", type: "email", autoComplete: "email", max: 254 },
  { name: "onlineEmail", label: "Email for Online Wise", type: "email", autoComplete: "off", max: 254 },
  { name: "lineId", label: "Searchable LINE ID", type: "text", autoComplete: "off", max: 64 },
  { name: "earliestStart", label: "Earliest start date", type: "date", autoComplete: "off", max: undefined },
] as const;

export function OnboardingForm({ token, submitted, linked, locked, lineIssue }: {
  token: string; submitted: boolean; linked: boolean; locked: boolean; lineIssue: boolean;
}) {
  const [saved, setSaved] = useState(submitted);
  const [isLinked, setLinked] = useState(linked);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(lineIssue ? "LINE sign-in did not finish. Try again or contact BeGifted HR." : "");
  const endpoint = `/api/hiring/onboarding/${encodeURIComponent(token)}`;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save your details. Try again.");
      setLinked(result.linked === true);
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save your details. Try again.");
    } finally { setPending(false); }
  }

  return <section className="mx-auto grid max-w-lg gap-4">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {saved ? <>
      <p role="status">BeGifted HR received your details.</p>
      {isLinked ? <p>LINE account linked. HR will review your details at contract signing.</p> : <>
        <p>Sign in with the LINE account you want BeGifted to invite.</p>
        <a className={cn(buttonVariants({ variant: "outline" }), "w-fit")} href={`${endpoint}/line`}>Connect LINE</a>
      </>}
      {!locked && <button className="w-fit text-sm underline underline-offset-4" type="button"
        onClick={() => { setError(""); setSaved(false); }}>Correct your details</button>}
    </> : <>
      <p>BeGifted HR uses these details for your contract and tutor account setup.</p>
      <form className="grid gap-4" onSubmit={save}>
        {fields.map((field) => <label key={field.name} className="grid gap-1 text-sm font-medium">
          {field.label}
          <input className="min-h-10 rounded-md border px-3 py-2 text-base" required name={field.name}
            type={field.type} autoComplete={field.autoComplete} maxLength={field.max} />
        </label>)}
        <button className={cn(buttonVariants(), "w-fit")} disabled={pending} type="submit">
          {pending ? "Saving…" : "Save details"}
        </button>
      </form>
    </>}
  </section>;
}
