// Browser storage quota: ask the browser not to evict the offline data
// (Safari clears script-writable storage after 7 days without use unless the
// app is installed or storage is persistent), and report usage for settings.

let persistRequested = false;

/** Non-blocking, at most once per page load; the browser may silently decline. */
export function requestPersistentStorage(): void {
  if (persistRequested || typeof navigator === "undefined" || !navigator.storage?.persist) return;
  persistRequested = true;
  void navigator.storage
    .persisted?.()
    .then((already) => (already ? true : navigator.storage.persist()))
    .catch(() => false);
}

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export async function readStorageEstimate(): Promise<StorageEstimate> {
  try {
    const [estimate, persisted] = await Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.()]);
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted: persisted ?? null };
  } catch {
    return { usage: null, quota: null, persisted: null };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
