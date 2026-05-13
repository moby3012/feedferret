# Admin customization

FeedFerret admins can customize several instance-level options in **Server Management**.

## Instance branding

Open **Server Management → Instance**:

- Set the public instance name.
- Upload a small sidebar icon/logo.
- Reset the logo back to the default FeedFerret icon.

The uploaded logo is stored as a small image data URL in the database so it survives container rebuilds as long as the database volume is retained. Keep the image below 180 KB.

The sidebar reads branding from `/api/instance` and displays the configured instance name and icon for all users.

## Starter packs

Open **Server Management → Starter Packs**:

- Enable/disable packs.
- Rename packs.
- Add or remove custom packs.
- Add, edit, remove, reorder, or duplicate feeds inside a pack.
- Import OPML into a pack.
- Export a pack as OPML.
- Reorder and duplicate packs.
- Reset to built-in defaults.

Default packs are hydrated from the built-in static OPML files so admins can inspect and edit their feeds. During sidebar import, FeedFerret generates OPML from the database-backed pack definition and updates existing feeds instead of creating duplicates.

Starter pack fields:

- **Title**: Display name of the feed in the OPML.
- **RSS/Atom URL**: Feed URL to import.
- **Website URL**: Optional website URL.
- **Category**: Optional category assigned during OPML import. Feeds with the same category are grouped in the generated OPML.

Validation rules:

- Enabled custom packs must contain at least one feed.
- RSS/Atom and website URLs must be valid `http` or `https` URLs.
- Duplicate feed URLs inside one pack are removed on save.
- Pack IDs are normalized and made unique automatically.

## User roles

Open **Server Management → Users**:

- Toggle a user between `USER` and `ADMIN`.
- Suspend/reactivate users.
- Delete users.

Safety rules:

- Admins cannot remove their own admin rights.
- The last admin cannot be demoted.

## Deployment note

These settings require the current Prisma schema. The Docker startup script runs `prisma db push`, so self-hosted Compose/Coolify deployments apply the new columns automatically on startup.
