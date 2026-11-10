import { preloadReaderChunks } from "@/components/reader/reader-view";
import { loadCommandPalette, loadShortcutsDialog } from "@/components/shell/shell-overlays";
import { loadFeedsScreen, loadRssSidebar } from "@/components/shell/sources-pane";

/**
 * The cold-start work made parts of the shell lazy chunks (sources pane, the reader's body / chrome /
 * "…" menu / "Aa" sheet, overlays). A chunk that was never needed while online is not in the service
 * worker's static cache, so opening it offline would fail with a ChunkLoadError (mobile: the Feeds tab). While the app is
 * online and idle we load the ones the offline flow needs (the SW caches `/_next/static` on first fetch).
 * The loaders are the shell's own — a separate `import()` of the same component lands in another chunk group.
 * Nothing is rendered; the modules are only fetched and evaluated.
 */
export function warmShellChunks(): Promise<unknown> {
  return Promise.allSettled([loadRssSidebar(), loadFeedsScreen(), preloadReaderChunks(), loadCommandPalette(), loadShortcutsDialog()]);
}
