"use client";

import { useEffect, useState } from "react";

// Recent search queries (spec §1.6: localStorage `ff:recent-q`, read after
// mount only). Recorded when the user submits (Enter) or leaves the field
// with a committed query — never the intermediate debounced commits.

const KEY = "ff:recent-q";
const MAX = 8;
const EVENT = "ff:recent-q";

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((q): q is string => typeof q === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function write(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: recent queries stay off */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function recordRecentQuery(q: string) {
  const query = q.trim();
  if (!query) return;
  write([query, ...read().filter((x) => x !== query)].slice(0, MAX));
}

export function clearRecentQueries() {
  write([]);
}

export function useRecentQueries(): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setList(read());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return list;
}
