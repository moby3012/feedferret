"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "feedferret:offline-articles:v1";
const MAX_ARTICLES = 100;

export function useOfflineArticleCache<T extends { id: string; publishedAt?: string | Date }>(articles: T[]) {
  const [isOffline, setIsOffline] = useState(false);
  const [cachedArticles, setCachedArticles] = useState<T[]>([]);

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
    try {
      const compact = articles
        .slice()
        .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
        .slice(0, MAX_ARTICLES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
      setCachedArticles(compact);
    } catch {
      // Offline cache is best-effort; ignore quota/private-mode failures.
    }
  }, [articles]);

  return {
    isOffline,
    articles: isOffline && articles.length === 0 ? cachedArticles : articles,
    hasOfflineSnapshot: cachedArticles.length > 0,
  };
}
