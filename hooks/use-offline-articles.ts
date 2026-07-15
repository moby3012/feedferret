"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "feedferret:offline-articles:v1";
const MAX_ARTICLES = 100;
const WRITE_DEBOUNCE_MS = 500;

// Note: this cache is only ever read back as a last-resort fallback when the app
// reloads while fully offline (no TanStack Query in-memory cache to fall back to
// first). Stripping `content` keeps that fallback list/excerpt view cheap to store,
// but means the article *detail* view won't have full HTML available for a
// previously-cached article in that scenario — only title/excerpt/metadata.
function stripHeavyFields<T extends { id: string; publishedAt?: string | Date }>(article: T) {
  const { content: _content, ...rest } = article as T & { content?: unknown };
  return rest as Omit<T, "content">;
}

export function useOfflineArticleCache<T extends { id: string; publishedAt?: string | Date }>(articles: T[]) {
  const [isOffline, setIsOffline] = useState(false);
  const [cachedArticles, setCachedArticles] = useState<T[]>([]);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const updateOnlineState = () => setIsOffline(!navigator.onLine);
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      setCachedArticles(raw ? JSON.parse(raw) : []);
    } catch {
      setCachedArticles([]);
    }
  }, []);

  useEffect(() => {
    if (!articles.length) return;

    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try {
        const compact = articles
          .slice()
          .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
          .slice(0, MAX_ARTICLES)
          .map(stripHeavyFields);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
        setCachedArticles(compact as T[]);
      } catch {
        // Offline cache is best-effort; ignore quota/private-mode failures.
      }
    }, WRITE_DEBOUNCE_MS);

    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [articles]);

  return {
    isOffline,
    articles: isOffline && articles.length === 0 ? cachedArticles : articles,
    hasOfflineSnapshot: cachedArticles.length > 0,
  };
}
