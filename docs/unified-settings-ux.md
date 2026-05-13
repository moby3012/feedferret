# Unified Settings UX

FeedFerret uses one shared settings modal shell for admin-style overlays so Settings, Feed Management, and Server Management feel consistent.

## Shared component

- `components/settings-shell.tsx`
  - `SettingsModalShell`: modal chrome, header, responsive tabs, and fixed-height content area.
  - `SettingsSection`: reusable card styling matching the User Settings page.
- `components/responsive-tabs-nav.tsx` remains the shared tab navigation primitive.

## Current consumers

- `components/feed-management.tsx`
  - Uses `SettingsModalShell` for Feed Management.
  - Tab content owns its scroll area; Import/Export, Rules, Alerts, Feeds, Categories, and Health are independently scrollable.
- `components/server-management-dialog.tsx`
  - Uses `SettingsModalShell` for Server Management.
  - Users, Access, Email, Instance, Starter Packs, and Sync use the same modal header/tabs and scroll model.
- `components/settings-form.tsx`
  - Remains the reference full-page settings experience.

## UX rules

1. Do not create custom modal chrome in management overlays.
2. Use `SettingsModalShell` for admin/settings modals with tabs.
3. Each tab body must fit within the modal and provide its own scroll behavior.
4. Keep cards rounded, high-contrast enough, and visually aligned with User Settings.
5. Keep mobile tab selection via `ResponsiveTabsNav` select fallback.

## Manual QA checklist

- Open User Settings, Feed Management, and Server Management and compare header/card style.
- Resize to mobile width and verify the tab select replaces desktop tabs.
- In Feed Management → Import/Export and Server Management → Starter Packs, verify long content scrolls inside the modal.
- Switch tabs repeatedly and verify scroll state/content does not escape the modal bounds.
