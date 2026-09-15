"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Suspense } from "react";

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/search";
  const error = searchParams.get("error");
  const attendanceLogin = callbackUrl.split("?")[0] === "/tutor-attendance";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-secondary to-accent/30">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-primary">BeGifted Ops</CardTitle>
          <CardDescription>
            {attendanceLogin ? "Office Attendance. Sign in with the Google account approved for your tutor profile." : "Internal operations platform. Sign in with your approved Google account."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error === "AccessDenied"
                ? "Access denied. Ask an administrator to check your approved sign-in email and access."
                : `Authentication error: ${error}`}
            </div>
          )}
          <Button
            className="w-full"
            onClick={() => signIn("google", { callbackUrl }, attendanceLogin ? { scope: "openid email profile", access_type: "online" } : undefined)}
          >
            Sign in with Google
          </Button>
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
