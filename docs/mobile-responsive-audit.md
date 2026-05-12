# Mobile responsive audit

## Ziel

FeedFerret soll auf schmalen Viewports ohne horizontales Scrollen bedienbar bleiben. Modals, Menüs, Tab-Navigationen und Verwaltungslisten müssen mobile-first funktionieren und dürfen wichtige Aktionen nicht nur per Hover zugänglich machen.

## Umgesetzte Änderungen

- Dialoge und Alert-Dialoge auf Viewport-Höhe/-Breite begrenzt.
- Gemeinsame `ResponsiveTabsNav` eingeführt: Mobile nutzt Select, Desktop nutzt Tabs.
- Feed-Management, Server-Management und Feed-Edit Dialoge responsiv umgebaut.
- Feed-, User-, Rule- und Alert-Zeilen auf Mobile gestapelt bzw. als Karten bedienbar gemacht.
- Hover-only Aktionen auf Touch-Geräten sichtbar gemacht.
- Notifications in die mobile Bottom-Navigation aufgenommen.
- Reader-Bottom-Bar reduziert; Zusatzaktionen liegen im More-Menü.
- Settings- und Setup-Formulare mit mobilen 1-Spalten-Grids und vollbreiten Controls angepasst.

## Prüfpunkte

- Kein horizontales Body-Scrolling bei 320px, 375px, 430px, 768px.
- Feed Management: Tabs als Select auf Mobile, Feed-Karten ohne Überlauf.
- Server Management: User-Aktionen und Settings-Karten ohne Überlauf.
- Feed Edit: Inhalt scrollt im Dialog, Footer bleibt erreichbar.
- Mobile Reader: Bottom-Bar passt auf schmale Displays.
- Sidebar/Drawer: Feed-Aktionen auf Touch sichtbar.
- Setup/Settings: Formulare stapeln sauber und bleiben bedienbar.

## Automatische Checks

- `pnpm exec tsc --noEmit`
- `pnpm run lint`
