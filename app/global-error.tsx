"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html>
      <body className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center font-sans">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-neutral-500 max-w-sm">
          A critical error occurred. Please reload the page.
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 text-sm border rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
