// F6: auto-mute + notify on persistently-failing feeds.
//
// FeedFerret already tracks Feed.lastStatus/lastError per sync, but had no
// concept of "this has been failing for N *consecutive* syncs". This module
// is the pure counter/threshold logic, kept separate from lib/rss-sync.ts's
// actual DB/notification side effects so it can be unit-tested directly
// (this codebase tests lib/* logic, not the server actions/DB wiring around
// it — see tests/lib/rss-sync.test.ts for the same split).

export type FeedFailureState = {
  consecutiveFailureCount: number;
  autoMuted: boolean;
};

export type FailureUpdateResult = FeedFailureState & {
  // True only on the exact sync that crosses the threshold — the caller uses
  // this to fire the one-time "feed was auto-muted" notification instead of
  // re-notifying on every subsequent failed sync of an already-muted feed.
  justMuted: boolean;
};

/**
 * Called after a failed sync. `threshold` is the user's
 * `autoMuteFailingFeedsAfter` setting; 0 (or any non-positive value) disables
 * auto-mute entirely — the counter still increments (useful for the health
 * dashboard) but the feed is never auto-muted.
 */
export function applySyncFailure(current: FeedFailureState, threshold: number): FailureUpdateResult {
  const consecutiveFailureCount = current.consecutiveFailureCount + 1;
  const shouldMute = !current.autoMuted && threshold > 0 && consecutiveFailureCount >= threshold;
  return {
    consecutiveFailureCount,
    autoMuted: current.autoMuted || shouldMute,
    justMuted: shouldMute,
  };
}

/**
 * Called after a successful sync (including a "not modified" 304): always
 * resets the counter and clears any mute, giving a feed that recovers on its
 * own a clean slate rather than requiring a manual unmute.
 */
export function applySyncSuccess(): FeedFailureState {
  return { consecutiveFailureCount: 0, autoMuted: false };
}

/**
 * Called when a user manually unmutes a feed: per spec, it gets a full reset
 * and "one more chance" rather than resuming right at the failure threshold.
 */
export function applyManualUnmute(): FeedFailureState {
  return { consecutiveFailureCount: 0, autoMuted: false };
}
