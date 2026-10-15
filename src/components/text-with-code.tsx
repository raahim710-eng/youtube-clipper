/** Renders text where `backticked` parts become inline code, e.g. hints like "Run `npm run db:migrate`". */
export function TextWithCode({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
