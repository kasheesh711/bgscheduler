"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Render the exact delivery document, isolated from application CSS and JS. */
export function TeacherEmailPreview({ subject, html, text }: {
  subject: string;
  html: string;
  text: string;
}) {
  const [plainText, setPlainText] = useState(false);
  const [mobile, setMobile] = useState(false);
  return (
    <div className="mt-3 space-y-3">
      <p className="break-words text-sm"><span className="font-medium">Subject: </span>{subject}</p>
      <div className="flex flex-wrap gap-2" aria-label="Email preview options">
        <Button type="button" size="sm" variant={plainText ? "outline" : "secondary"} aria-pressed={!plainText} onClick={() => setPlainText(false)}>Email</Button>
        <Button type="button" size="sm" variant={plainText ? "secondary" : "outline"} aria-pressed={plainText} onClick={() => setPlainText(true)}>Plain text</Button>
        {!plainText && <Button type="button" size="sm" variant="outline" aria-pressed={mobile} onClick={() => setMobile(value => !value)}>Phone width</Button>}
      </div>
      {plainText ? (
        <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-4 font-sans text-sm">{text}</pre>
      ) : (
        <div className="overflow-hidden rounded-md border bg-[#F6F8FB]">
          <iframe
            title={`Email preview: ${subject}`}
            srcDoc={html}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
            className="mx-auto block h-[640px] w-full border-0"
            style={{ maxWidth: mobile ? 375 : undefined }}
          />
        </div>
      )}
    </div>
  );
}
