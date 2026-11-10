import type { QueryClient } from "@tanstack/react-query";

// The app's QueryClient, for code outside React that must reach the
// account-scoped cache (logout cleanup).
let active: QueryClient | null = null;

export function setActiveQueryClient(qc: QueryClient | null) {
  active = qc;
}

export function getActiveQueryClient(): QueryClient | null {
  return active;
}
