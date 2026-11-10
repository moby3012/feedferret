"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/features/articles/api";

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

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
