/** A stored form answer. A web address in it (a portfolio link, or the uploaded file) opens in a new tab. */
export function AnswerText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s]+)/).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer noopener">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
