"use client";

import { QueryCache, QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "@/features/articles/api";
import { ArticleActionsProvider } from "@/features/articles/mutations";
import { setActiveQueryClient } from "@/lib/active-query-client";

// Optimistic patches (`setQueryData`) must reach React before the next frame:
// star / read-later / read flip in the same frame as the tap. TanStack's
// default notify scheduler is setTimeout(0), a separate task the browser may
// run only after the next rAF + paint, so a click could still show the old
// icon one frame later. A microtask runs before any rendering opportunity.
notifyManager.setScheduler(queueMicrotask);

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // A 401 from the session-only /api/app/* endpoints means the session is
        // gone: go to the login page instead of showing an empty, broken list.
        queryCache: new QueryCache({
          onError: (error) => {
            if (error instanceof ApiError && error.status === 401 && window.location.pathname !== "/login") {
              window.location.replace("/login");
            }
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
          },
        },
      }),
  );

  useEffect(() => {
    setActiveQueryClient(queryClient);
    return () => setActiveQueryClient(null);
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ArticleActionsProvider>{children}</ArticleActionsProvider>
    </QueryClientProvider>
  );
}
