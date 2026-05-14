"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface DiscoveryFeed {
  url: string;
  title: string;
  description: string | null;
  siteUrl: string | null;
  iconUrl: string | null;
  type: "rss" | "atom" | "json";
}

export interface CatalogFeed {
  id: string;
  url: string;
  title: string;
  description: string | null;
  category: string;
  language: string;
  iconUrl: string | null;
  popularity: number;
}

export interface DiscoveryCategory {
  id: string;
  name: string;
  icon: string;
  feedCount: number;
}

async function searchFeeds(query: string): Promise<{
  feeds: DiscoveryFeed[];
  source: string;
  error?: string;
}> {
  const res = await fetch(`/api/discovery/search?q=${encodeURIComponent(query)}`);
  if (res.status === 429) {
    const data = await res.json();
    throw new Error(`Rate limit exceeded. Try again in ${data.retryAfter}s`);
  }
  if (!res.ok) {
    throw new Error("Search failed");
  }
  return res.json();
}

async function getCategories(): Promise<{ categories: DiscoveryCategory[] }> {
  const res = await fetch("/api/discovery/catalog");
  if (!res.ok) throw new Error("Failed to load categories");
  return res.json();
}

async function getCatalogFeeds(
  category: string,
  language?: string
): Promise<{ feeds: CatalogFeed[]; category: string }> {
  const params = new URLSearchParams({ category });
  if (language) params.set("language", language);
  const res = await fetch(`/api/discovery/catalog?${params}`);
  if (!res.ok) throw new Error("Failed to load feeds");
  return res.json();
}

export function useDiscoverySearch(query: string, enabled = true) {
  return useQuery({
    queryKey: ["discovery", "search", query],
    queryFn: () => searchFeeds(query),
    enabled: enabled && query.length >= 2,
    staleTime: 5 * 60 * 1000, // Cache for 5 min
    retry: false,
  });
}

export function useDiscoveryCategories(enabled = true) {
  return useQuery({
    queryKey: ["discovery", "categories"],
    queryFn: getCategories,
    enabled,
    staleTime: 10 * 60 * 1000, // Cache for 10 min
  });
}

export function useDiscoveryCatalog(
  category: string | null,
  language?: string,
  enabled = true
) {
  return useQuery({
    queryKey: ["discovery", "catalog", category, language],
    queryFn: () => getCatalogFeeds(category!, language),
    enabled: enabled && !!category,
    staleTime: 5 * 60 * 1000,
  });
}
