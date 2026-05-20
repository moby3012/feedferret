# Translation Pull Request

## Language Info

- Language name:
- Language code (BCP 47):
- Locale file: `messages/XX.json`

## Coverage Checklist

- [ ] Language code and locale file: `messages/XX.json`
- [ ] All keys from `messages/en.json` are present (run `pnpm run translations:check`)
- [ ] Zero machine-translation-only strings (native-speaker reviewed)
- [ ] ICU plural forms correct for this language

## Quality Checklist

- [ ] Tested in the app by setting locale cookie to the new locale
- [ ] No untranslated English strings visible in the UI
- [ ] Date/number formats validated for the locale

## Testing Steps

1. Copy `messages/en.json` to `messages/XX.json` (replace `XX` with the language code).
2. Translate all string values, preserving ICU placeholders (e.g. `{count}`, `{users}`).
3. Run `pnpm run translations:check` and confirm no missing keys are reported.
4. Start the app and set the locale cookie to `XX` in your browser DevTools.
5. Navigate through the main views (sidebar, article list, reader, settings) and confirm no English strings are visible.
6. Verify date and number formatting is appropriate for the locale.

---

Native speaker sign-off: @github_handle
