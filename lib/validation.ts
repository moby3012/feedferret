// Shared input-validation constants and helpers used by server actions and API routes.

import { z } from "zod";

export const MAX_FEED_URL_LENGTH = 2048;
export const MAX_OPML_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_OPML_FEEDS = 500;
export const MAX_LABEL_NAME = 100;
export const MAX_SEARCH_QUERY = 1000;
export const MAX_SAVED_SEARCH_NAME = 255;

export function validateFeedUrl(url: string): string | null {
  if (url.length > MAX_FEED_URL_LENGTH) return "Feed URL exceeds maximum length";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Feed URL must use http or https";
    return null;
  } catch {
    return "Invalid feed URL";
  }
}

export function validateOpml(xml: string): string | null {
  const bytes = Buffer.byteLength(xml, "utf8");
  if (bytes > MAX_OPML_BYTES) return `OPML file too large (max ${MAX_OPML_BYTES / 1024 / 1024} MB)`;
  return null;
}

export const CreateFeedSchema = z.object({
  url: z.string().url("Must be a valid URL").max(2048),
  name: z.string().max(200).optional(),
  categoryId: z.string().optional(),
  icon: z.string().max(100).optional(),
});

export const UpdateFeedSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  categoryId: z.string().nullable().optional(),
  updateFrequency: z.number().int().min(5).max(10080).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  priority: z.enum(["important", "main", "category", "feed", "hidden"]).optional(),
  hideFromAllFeeds: z.boolean().optional(),
  hideArticleImage: z.boolean().optional(),
});

export const RegisterUserSchema = z.object({
  email: z.string().email("Must be a valid email address").max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().max(200).optional(),
});

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(100),
  parentId: z.string().optional(),
});

export const SavedSearchSchema = z.object({
  name: z.string().min(1).max(100),
  query: z.string().min(1).max(500),
});

export const KeywordAlertSchema = z.object({
  name: z.string().min(1).max(100),
  query: z.string().min(1).max(500),
  scope: z.string().max(100).optional(),
  actions: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export type CreateFeedInput = z.infer<typeof CreateFeedSchema>;
export type UpdateFeedInput = z.infer<typeof UpdateFeedSchema>;
