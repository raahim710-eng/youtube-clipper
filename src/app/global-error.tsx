"use client";

/**
 * Last-resort error page when the root layout itself fails.
 * Must render its own <html>/<body> and can't rely on app styles or providers.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.5rem" }}>The app couldn&apos;t start this page</h1>
        <p>Something went wrong at a basic level. Restart the app, and check the terminal for errors.</p>
        {error.digest ? <p style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>Reference: {error.digest}</p> : null}
        <button type="button" onClick={reset} style={{ padding: "0.5rem 1rem", cursor: "pointer" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
