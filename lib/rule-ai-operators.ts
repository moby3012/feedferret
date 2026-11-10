// K3: search operators whose value is DERIVED by the AI/heuristic enrichment
// (is:sponsored, is:clickbait, entity:). Enrichment is probabilistic and can be
// wrong or later revised, so an auto-read rule built on it must never take an
// irreversible action. Pure + dependency-free so the settings UI can use the
// same check as the server paths (server actions, REST v1, MCP, rule runner).

// Mirrors the aliases accepted by lib/search.ts for the K3 operators.
const AI_DERIVED_OPERATOR = new RegExp(
  "(?:^|[\\s(])-?(?:" +
    "(?:is|status):[\"']?(?:sponsored|ad|ads|anzeige|werbung|clickbait)(?![\\p{L}\\p{N}])" +
    "|(?:entity|entities|ent):" +
    ")",
  "iu",
);

export function queryUsesAiDerivedOperators(query: string | null | undefined): boolean {
  return !!query && AI_DERIVED_OPERATOR.test(query);
}

/** Actions that destroy data and therefore cannot be driven by AI-derived operators. */
export function isDestructiveRuleAction(action: string): boolean {
  return action === "delete";
}

export function ruleHasAiDeleteConflict(query: string | null | undefined, actions: readonly string[]): boolean {
  return queryUsesAiDerivedOperators(query) && actions.some(isDestructiveRuleAction);
}

/** English fallback for API/server errors; the UI shows the translated `rules.aiOperatorDeleteBlocked`. */
export const AI_OPERATOR_DELETE_ERROR =
  "Rules that use is:sponsored, is:clickbait or entity: are AI-derived and cannot use the delete action.";
