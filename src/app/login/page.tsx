"use client";

import { getProviders, signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { loginDestination } from "@/lib/auth/login-destination";

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = loginDestination(searchParams.get("callbackUrl"));
  const error = searchParams.get("error");
  const attendanceLogin = callbackUrl.split("?")[0] === "/tutor-attendance";
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    void getProviders().then((providers) => setEmailEnabled(!!providers?.["email-code"])).catch(() => undefined);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const expired = !!expiresAt && now >= expiresAt;

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    setPending(true); setFormError("");
    try {
      const response = await fetch("/api/auth/email-code/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim().toLowerCase() }) });
      const data = await response.json();
      const time = Date.now(); setNow(time);
      if (data.retryAfter) setRetryAt(time + data.retryAfter * 1000);
      if (!response.ok) throw new Error(data.error || "Could not request a code. Please try again.");
      setEmail(email.trim().toLowerCase()); setCode(""); setChallengeId(data.challengeId);
      setExpiresAt(time + data.expiresIn * 1000); setMessage(data.message);
    } catch (e) { setFormError(e instanceof Error ? e.message : "Could not request a code. Please try again."); }
    finally { setPending(false); }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault(); setPending(true); setFormError("");
    try {
      const result = await signIn("email-code", { email, code, challengeId, redirect: false, redirectTo: callbackUrl });
      if (!result?.ok || result.error) throw new Error("That code is invalid or expired, or this email no longer has access. Try again or request a new code.");
      window.location.assign(callbackUrl);
    } catch (e) { setFormError(e instanceof Error ? e.message : "Sign-in failed. Please try again."); setPending(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-secondary to-accent/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-primary">BeGifted Ops</CardTitle>
          <CardDescription>
            {attendanceLogin ? "Office Attendance. Sign in with the email approved for your tutor profile." : "Internal operations platform. Sign in with your approved email."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error === "AccessDenied"
                ? "Access denied. Ask an administrator to check your approved sign-in email and access."
                : "Sign-in could not be completed. Please try again."}
            </div>
          )}
          <Button
            className="w-full"
            onClick={() => signIn("google", { callbackUrl }, attendanceLogin ? { scope: "openid email profile", access_type: "online" } : undefined)}
          >
            Sign in with Google
          </Button>
          {emailEnabled && (
            <>
              <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or use an email code<span className="h-px flex-1 bg-border" /></div>
              <form className="space-y-4" onSubmit={challengeId ? verifyCode : requestCode}>
                <div className="space-y-2">
                  <label htmlFor="login-email" className="text-sm font-medium">Approved email</label>
                  <input id="login-email" type="email" autoComplete="email" required maxLength={254} value={email} readOnly={!!challengeId} disabled={pending}
                    onChange={(e) => setEmail(e.target.value)} className="h-11 w-full rounded-md border bg-background px-3 text-base" placeholder="you@example.com" />
                </div>
                {challengeId && (
                  <div className="space-y-2">
                    <label htmlFor="login-code" className="text-sm font-medium">Six-digit code</label>
                    <input id="login-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={pending || expired}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="h-11 w-full rounded-md border bg-background px-3 text-lg tracking-widest" aria-describedby="login-status" />
                  </div>
                )}
                <div id="login-status" aria-live="polite" className="space-y-2 text-sm">
                  {message && <p className="text-muted-foreground">{expired ? "This code has expired. Request a new code below." : message}</p>}
                  {formError && <p role="alert" className="text-destructive">{formError}</p>}
                </div>
                <Button type="submit" className="w-full" disabled={pending || (!!challengeId && expired) || (!challengeId && remaining > 0)}>
                  {pending ? "Please wait…" : challengeId ? "Verify and sign in" : "Send sign-in code"}
                </Button>
                {challengeId && <div className="flex flex-wrap justify-between gap-2">
                  <Button type="button" variant="ghost" disabled={pending || remaining > 0} onClick={() => void requestCode()}>{remaining ? `Resend in ${remaining}s` : "Resend code"}</Button>
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => { setChallengeId(""); setCode(""); setMessage(""); setFormError(""); setExpiresAt(0); setRetryAt(0); }}>Change email</Button>
                </div>}
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
