import { getJson } from "@/features/articles/api";
import type { Counts } from "./types";

export function fetchCounts(signal?: AbortSignal): Promise<Counts> {
  return getJson<Counts>("/api/app/counts", signal);
}
