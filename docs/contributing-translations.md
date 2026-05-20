# Contributing Translations

FeedFerret uses [next-intl](https://next-intl-docs.vercel.app/) for internationalization. All user-visible strings live in `messages/*.json`. Adding a new language requires no code changes beyond creating a JSON file and registering the locale tag.

---

## Adding a New Locale

### 1. Create the message file

Copy `messages/en.json` to `messages/<locale>.json`, where `<locale>` is a two-letter BCP-47 tag (e.g., `fr` for French, `es` for Spanish, `ja` for Japanese).

```bash
cp messages/en.json messages/fr.json
```

Translate every value in the new file. Do **not** translate the keys — only the values.

### 2. Register the locale

Add the locale tag to the `SUPPORTED_LOCALES` array in two places:

**`i18n/request.ts`:**
```typescript
const SUPPORTED_LOCALES = ['en', 'de', 'fr']; // add your tag here
```

**`middleware.ts`:**
```typescript
const SUPPORTED_LOCALES = ['en', 'de', 'fr']; // add your tag here
```

### 3. Add the language option to the settings picker

In `components/settings-form.tsx`, inside the `LanguageSection` component, add a `SelectItem` for the new locale:
```tsx
<SelectItem value="fr">Français</SelectItem>
```

Use the language name written in that language (e.g., "Français", not "French").

### 4. Add the display name to the message files

In every existing `messages/*.json`, add an entry under `settings.languageOptions`:
```json
"languageOptions": {
  "en": "English",
  "de": "Deutsch",
  "fr": "Français"
}
```

---

## Key Naming Convention

Keys follow a flat-ish namespace pattern:

```
<namespace>.<key>
```

Examples:
- `settings.title` — the Settings page title
- `login.errors.incorrectCredentials` — a login error message
- `common.save` — a generic "Save" button label

Nesting is allowed up to **three levels deep**. Avoid deeper nesting.

**Rules:**
- Keys are `camelCase`
- Namespaces reflect the feature area (`settings`, `login`, `sidebar`, `articleReader`, etc.)
- The English string in `en.json` is the canonical source of truth — never change keys without updating all locale files

---

## ICU Message Format

FeedFerret uses ICU MessageFormat for dynamic strings (plurals, variables). Examples:

**Simple variable:**
```json
"signedInAs": "Signed in as {name}"
```

**Plural:**
```json
"feedCount": "{count, plural, one {# feed} other {# feeds}}"
```

Keep ICU syntax intact when translating — only translate the human-readable text portions, not the variable names or plural keywords (`one`, `other`, `zero`, `few`, `many`).

---

## Testing a New Locale Locally

Set the `locale` cookie in your browser to test:

**Chrome DevTools:**
1. Open DevTools → Application → Cookies → `localhost`
2. Add a cookie: Name = `locale`, Value = `fr`, Path = `/`
3. Reload the page

**curl:**
```bash
curl -H "Cookie: locale=fr" http://localhost:3000/
```

**Accept-Language header** (for unauthenticated pages):
```bash
curl -H "Accept-Language: fr,en;q=0.9" http://localhost:3000/login
```

---

## Coverage Requirement

Every key present in `messages/en.json` **must** exist in your locale file. Missing keys will cause runtime errors in production.

To check coverage manually, compare key counts:
```bash
# Count top-level keys in en.json (rough check)
node -e "const en = require('./messages/en.json'); const fr = require('./messages/fr.json'); console.log('EN keys:', JSON.stringify(Object.keys(en))); console.log('FR keys:', JSON.stringify(Object.keys(fr)));"
```

A proper coverage script (`scripts/check-translations.ts`) is planned for CI — see `docs/releases/v1.1-i18n.md`.

---

## Pull Request Checklist

Before opening a translation PR, verify:

- [ ] `messages/<locale>.json` contains 100% of the keys in `messages/en.json`
- [ ] Locale is registered in both `SUPPORTED_LOCALES` arrays
- [ ] `SelectItem` added to the language picker in `settings-form.tsx`
- [ ] Display name added to all existing `messages/*.json` under `settings.languageOptions`
- [ ] ICU placeholders (`{name}`, `{count, plural, ...}`) are preserved unchanged
- [ ] No English text remains in the translated file (except for proper nouns and brand names that are not typically translated, e.g., "FeedFerret", "Ollama", "Telegram")
- [ ] Translation has been reviewed by a native speaker or a fluent speaker of the language

---

## Fallback Strategy

If a key is missing in the active locale, next-intl will not silently fall back to English in production — it will throw. Always ensure 100% key coverage before shipping. In development mode, next-intl emits a console warning for missing keys.
