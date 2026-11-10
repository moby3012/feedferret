/**
 * Overlays whose open state lives in the nav store / `history.state.ff`
 * (system back closes them). Overlays never nest: opening one while another
 * is open swaps it (the history entry is reused).
 */
export type OverlayId =
  | "sources"
  | "save-search"
  | "list-menu"
  | "palette"
  | "shortcuts"
  | "add-feed"
  | "article-menu"
  | "reader-menu"
  | "reader-aa"
  | "feed-menu"
  | "feeds-menu"
  | "notifications";
