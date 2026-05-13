import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_STARTER_PACKS,
  parseStarterPacksJson,
  type StarterPack,
  type StarterPackFeed,
} from "@/lib/starter-packs";
import { parseOpml, type OpmlOutline } from "@/lib/opml";

function flattenOutlines(outlines: OpmlOutline[], inheritedCategory = ""): StarterPackFeed[] {
  return outlines.flatMap((outline) => {
    const category = outline.category || inheritedCategory;
    if (outline.xmlUrl) {
      return [{
        title: outline.text || outline.title || outline.xmlUrl,
        xmlUrl: outline.xmlUrl,
        htmlUrl: outline.htmlUrl || "",
        category,
      }];
    }
    return flattenOutlines(outline.children || [], outline.text || category);
  });
}

async function readPackFeeds(pack: StarterPack) {
  if (!pack.path) return [];
  try {
    const filePath = path.join(process.cwd(), "public", "starter-opml", pack.path);
    const xml = await readFile(filePath, "utf8");
    return flattenOutlines(await parseOpml(xml));
  } catch {
    return [];
  }
}

export async function hydrateStarterPackFiles(packs: StarterPack[]) {
  return Promise.all(
    packs.map(async (pack) => {
      if (!pack.path || pack.feeds.length > 0) return pack;
      const feeds = await readPackFeeds(pack);
      return feeds.length > 0 ? { ...pack, feeds } : pack;
    }),
  );
}

export async function getStarterPacksFromSettings(starterPacksJson?: string | null) {
  const packs = starterPacksJson
    ? parseStarterPacksJson(starterPacksJson)
    : DEFAULT_STARTER_PACKS;
  return hydrateStarterPackFiles(packs);
}
