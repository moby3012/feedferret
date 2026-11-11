// Shared gesture module (.pm/spec-shell-design.md §5): one implementation of
// swipe, pull, long-press, spring and haptics for every surface.
export { createSwipeRow, type SwipeAction, type SwipeRowOptions, type LongPressPoint } from "./swipe-row";
export { createPull, type PullOptions } from "./pull";
export { haptic, type HapticKind } from "./haptics";
export { springBack } from "./spring";
export { activeGesture, cancelActiveGesture, documentDir, recentlyScrolled } from "./guards";
export { useGesturePrefs, getGesturePrefs, setGesturePref, SWIPE_ACTIONS, DEFAULT_GESTURE_PREFS, type GesturePrefs, type SwipeActionId } from "./prefs";
export * from "./math";
export { claimGestureNudge, completeBackHint, completeFeedsHint, completeGestureHint, resetBackHint, resetFeedsHint, resetGestureHint, useBackHintDue, useFeedsHintDue, useGestureHintDue, useTouchRows, BACK_HINT_KEY, FEEDS_HINT_KEY, GESTURE_HINT_KEY, GESTURE_NUDGE_KEY, TOUCH_ROWS_QUERY } from "./coach";
export { createBackSwipe, type BackSwipeOptions } from "./back-swipe";
export * from "./back-swipe-math";
