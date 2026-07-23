import { Fragment } from "react";

/**
 * Wraps digit runs in the `digits` utility so numerals inside display-font
 * (Cormorant) text render in Sarabun.
 */
export function DigitSafe({ text }: { text: string }) {
  const parts = text.split(/(\d+)/);
  return (
    <>
      {parts.map((part, index) =>
        /^\d+$/.test(part) ? (
          <span key={index} className="digits">
            {part}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
