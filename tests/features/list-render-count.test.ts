// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, memo, type ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import messages from "../../messages/de.json";
import { toLegacyArticle, type LegacyArticle, type LegacyContext } from "../../features/articles/legacy-adapter";
import type { ArticleListItem } from "../../features/articles/types";
import { ArticleListView } from "../../components/list/article-list-view";

// Render-count check of the list (#235 review): a cache write for one row must
// re-render that row only — story cards included (their `cluster` prop used
// to be a fresh object on every regroup, which defeated ArticleRow's memo).

const renders = vi.hoisted(() => new Map<string, number>());

vi.mock("@/components/list/article-row", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/list/article-row")>();
  const Inner = (actual.ArticleRow as unknown as { type: (p: ComponentProps<typeof actual.ArticleRow>) => ReturnType<typeof createElement> }).type;
  const Counted = memo(function CountedArticleRow(p: ComponentProps<typeof actual.ArticleRow>) {
    renders.set(p.article.id, (renders.get(p.article.id) ?? 0) + 1);
    return Inner(p);
  });
  return { ...actual, ArticleRow: Counted };
});
vi.mock("@/features/articles/mutations", () => ({
  useArticleActions: () => ({ markIdsRead: vi.fn(), markRangeRead: vi.fn() }),
}));
vi.mock("@/features/reader/nav/scroll-memory", () => ({ useRestoreGate: () => true, useScrollMemory: () => {} }));
vi.mock("@/features/reader/nav/store", () => ({
  useNav: (selector: (s: { overlay: null }) => unknown) => selector({ overlay: null }),
  nav: { openOverlay: vi.fn(), closeOverlay: vi.fn() },
}));


// Provider props are hoisted: a new `now` per render would re-render every intl consumer.
const NOW = new Date("2026-11-10T12:00:00Z");
const noop = () => {};
const ctx: LegacyContext = { feedsById: new Map([["f1", { id: "f1", name: "Feed" }]]), labelsById: new Map(), labelsReady: true };

function item(id: string, extra: Partial<ArticleListItem> = {}): ArticleListItem {
  return {
    id,
    feedId: "f1",
    title: `Title ${id}`,
    link: `https://example.test/${id}`,
    excerpt: "",
    author: null,
    publishedAt: "2026-11-10T10:00:00.000Z",
    createdAt: "2026-11-10T10:00:00.000Z",
    imageUrl: null,
    kind: "article",
    media: null,
    readMinutes: 2,
    isRead: false,
    isStarred: false,
    isReadLater: false,
    isSpoiler: false,
    isDuplicate: false,
    duplicateCount: 0,
    canonicalFeedName: null,
    labelIds: [],
    ...extra,
  };
}

describe("ArticleListView render counts", () => {
  let root: Root;
  let host: HTMLElement;
  const qc = new QueryClient();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    renders.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (articles: LegacyArticle[]) =>
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(
            NextIntlClientProvider,
            { locale: "de", messages, timeZone: "Europe/Berlin", now: NOW } as unknown as ComponentProps<typeof NextIntlClientProvider>,
            createElement(ArticleListView, {
              articles,
              selectedArticle: null,
              onSelectArticle: noop,
              onToggleRead: noop,
              groupStories: true,
              legacyContext: ctx,
              pageSize: 50,
            }),
          ),
        ),
      );
    });

  it("a write to one row re-renders that row only (story card and other rows keep their memo)", () => {
    const cluster = { clusterId: "c1", clusterSize: 3, clusterLeadId: "lead" };
    const items = [item("u1"), item("lead", cluster), item("u2"), item("member", cluster)];
    const first = items.map((i) => toLegacyArticle(i, ctx));
    render(first);
    expect(Object.fromEntries(renders)).toEqual({ u1: 1, lead: 1, u2: 1 }); // "member" folded under the card

    // The cache patched u1 (new row object); everything else is the same object.
    const next = [toLegacyArticle(item("u1", { isRead: true }), ctx), ...first.slice(1)];
    render(next);
    expect(Object.fromEntries(renders)).toEqual({ u1: 2, lead: 1, u2: 1 });

    // A folded member changes: the card's cluster state (id / more / expanded) is unchanged → no re-render.
    const third = [...next.slice(0, 3), toLegacyArticle(item("member", { ...cluster, isRead: true }), ctx)];
    render(third);
    expect(Object.fromEntries(renders)).toEqual({ u1: 2, lead: 1, u2: 1 });
  });
});
