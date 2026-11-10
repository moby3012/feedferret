import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge must know the custom design tokens from app/styles/tokens.css,
 * otherwise an unknown `text-display` / `text-caption` is mistaken for a text
 * *colour* and silently dropped when it meets `text-foreground`, and role radii
 * / elevation / tracking tokens never dedupe against their Tailwind siblings.
 * Keep these lists in sync with tokens.css (tests/design/cn-merge.test.ts).
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['caption', 'footnote', 'body-sm', 'body', 'row-title', 'title-sm', 'title', 'headline', 'display'],
      radius: ['chip', 'control', 'row', 'panel', 'sheet', 'icon', 'inherit'],
      shadow: ['bar', 'overlay'],
      blur: ['bar', 'overlay'],
      tracking: ['title', 'subtitle', 'overline'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
