# FeedFerret Marketing Landing Page Brief

This document is a comprehensive source of truth for the current FeedFerret product surface. It is intended as the foundation for a future marketing landing page, homepage rewrite, launch page, product hunt page, press page, or feature comparison page.

---

## 1. Product Summary

**FeedFerret** is a self-hostable, multi-user RSS reader designed for people who want control, speed, privacy, and a polished reading experience.

It combines:

- a modern reading UI
- strong self-hosting support
- multi-user account isolation
- automation and filtering tools
- mobile-friendly reading flows
- installable PWA support
- email digests and flexible mail delivery
- compatibility with external RSS clients via Google Reader API

FeedFerret is built for personal use, family servers, teams, and advanced self-hosters who want more control than mainstream feed readers provide.

---

## 2. Core Positioning

### Main value proposition

FeedFerret helps users **collect, filter, organize, and read RSS feeds in a fast and pleasant interface** while keeping ownership of their data and deployment.

### Ideal audience

- self-hosters
- RSS power users
- privacy-conscious readers
- researchers and analysts
- people replacing services like Feedly, Inoreader, or self-hosted Scout Studio setups
- users who want a modern mobile-friendly reader UI
- users who want Reeder-style ergonomics with self-hosting flexibility

### Key differentiators

- self-hosted and multi-user from the start
- modern UI instead of a legacy admin-style feed reader
- mobile UX optimized for thumb reach and gestures
- advanced saved search and search sharing support
- labels, rules, retention, full-text extraction, and feed health tooling
- native-client compatibility through Google Reader API
- optional local 2FA and optional Authelia SSO
- flexible mail delivery including SMTP and API-based providers

---

## 3. High-Level Feature Overview

### Reading experience

- clean article reading interface
- multiple article list layouts
- dynamic theming
- dark mode
- mobile-optimized reading controls
- gesture-based article navigation on mobile
- bottom thumb controls on mobile
- read/unread, starred, and read-later actions
- automatic mark-as-read timing controls
- optional open-original behavior

### Organization

- feeds
- categories
- nested categories
- labels
- saved searches
- shared saved searches
- starred articles
- read-later articles

### Automation and power-user tools

- auto-mark-as-read rules
- rule previews
- retention policies
- feed extraction previews
- feed health dashboard
- keyboard shortcuts
- selective OPML export
- user data export

### Sync and integrations

- background feed sync
- external sync endpoint
- Google Reader API compatibility
- OAuth login options
- Authelia OIDC login
- email digests
- flexible email providers

### Self-hosting and admin

- multi-user support
- admin server management UI
- registration control
- server-wide mail settings
- self-hosting docs
- SQLite-based default deployment
- Docker-friendly deployment path

---

## 4. Detailed Feature Inventory

### 4.1 Multi-user architecture

FeedFerret supports multiple accounts on one installation.

Included:

- isolated per-user feeds, categories, labels, searches, and articles
- admin and user roles
- registration control
- account-based settings
- per-user reading preferences

Marketing angle:

> Run one private RSS service for yourself, your family, or your team.

---

### 4.2 Authentication options

FeedFerret now supports multiple authentication paths.

#### Local authentication

- email and password login
- registration flow
- initial setup flow for first account

#### Magic link email authentication

- email sign-in via Auth.js email flow
- mail delivery controlled by server mail settings

#### OAuth providers

- Google OAuth
- GitHub OAuth
- optional Authelia OIDC login

#### Optional 2FA

- optional TOTP-based authenticator app support
- enabled per user
- setup from user settings
- 6-digit verification code flow
- supports apps like Authy, Aegis, Google Authenticator, 1Password, etc.

#### Self-hosting identity support

- optional Authelia login for users who want centralized auth
- good fit for private homelabs and internal deployments

Marketing angle:

> Sign in your way: local accounts, magic links, OAuth, or Authelia SSO.

---

### 4.3 Reading interface

FeedFerret provides a modern reader-style experience instead of a plain database table UI.

Included:

- article list and article reader
- read/unread state management
- starring
- read-later saving
- article metadata display
- author, feed, and date context
- external link opening
- automatic reader scroll reset when navigating articles

User settings include:

- open original by default
- mark as read timing
- default list layout
- reader width
- default sort order
- accent colors

Marketing angle:

> Built for actual reading, not just feed storage.

---

### 4.4 Mobile UX refactor

The mobile experience has been significantly improved and is now one of the product's strongest UX points.

Included:

- mobile bottom navigation for thumb reach
- bottom drawer instead of relying on a left sidebar
- mobile reader bottom controls
- swipe gestures for next/previous navigation
- scroll-to-top button in the mobile reader
- better safe-area handling
- reduced visual clutter in mobile header areas
- layout fixes to avoid broken split-screen mobile states
- feed navigation fixes from mobile drawer and article context

Inspirational direction:

- Reeder-style ergonomics
- gesture-enhanced reading
- one-handed reading flow

Marketing angle:

> A self-hosted RSS reader that actually feels good on a phone.

---

### 4.5 PWA support

FeedFerret can be installed as a Progressive Web App.

Included:

- manifest support
- installable app behavior
- add-to-home-screen guidance
- first-visit mobile install prompt
- settings shortcut to reopen install instructions
- offline fallback page
- lightweight service worker registration
- app badge support where supported by the browser
- mobile-home-screen-friendly experience

Marketing angle:

> Install FeedFerret like an app on your phone or tablet.

---

### 4.6 Feeds and categories

Core RSS management features include:

- add feeds
- delete feeds
- edit feeds
- category assignment
- nested categories
- category management
- per-feed ordering
- category ordering
- feed refresh controls
- global refresh

Feed-specific advanced options include:

- authentication for protected feeds
- custom user-agent
- request timeout
- SSL verification control
- content size limits
- update frequency overrides

Marketing angle:

> Organize hundreds of feeds without chaos.

---

### 4.7 Search and saved searches

Search is a major part of the product surface.

Included:

- advanced query syntax
- filters by feed
- filters by category
- `is:starred`
- `is:unread`
- label filters
- date filters
- saved searches

#### Saved search sharing

Recently added:

- share a saved search via secret token link
- public read-only HTML page for shared search results
- RSS output for shared search results
- enable/disable sharing per saved search
- invalidation of old links when sharing is turned off

Marketing angle:

> Turn your search into a living feed — and even share it.

---

### 4.8 Labels, starred, and read later

Users can organize articles beyond folders.

Included:

- label creation
- label editing
- label deletion
- assign labels to articles
- color-coded label workflows
- starred article workflow
- read-later workflow
- unread and read state tracking

Marketing angle:

> Use categories for structure, labels for meaning, and saved searches for intelligence.

---

### 4.9 Auto rules and automation

FeedFerret includes automation features for serious readers.

#### Auto-mark-as-read rules

Included:

- rule creation
- rule editing
- rule deletion
- query-based matching
- rule ordering
- rule previewing before activation
- actions like mark-read, star, or apply label
- apply rules now action

Marketing angle:

> Let low-value noise disappear automatically.

---

### 4.10 Full-text extraction

FeedFerret supports per-feed extraction enhancements for truncated or partial feeds.

Included:

- per-feed CSS selector configuration
- full-text fetching support
- extraction preview tooling
- better long-form reading from incomplete feeds

Marketing angle:

> Upgrade thin feeds into a real reading experience.

---

### 4.11 Retention policies

FeedFerret includes built-in cleanup controls to keep databases manageable.

Included:

- retention windows
- dry-run preview
- article cleanup
- preservation logic for important content
- minimum retained article count behavior
- protection for starred and labeled content

Marketing angle:

> Keep your archive under control without losing what matters.

---

### 4.12 Feed health dashboard

FeedFerret includes visibility into the health of a feed collection.

Included:

- article count
- unread count
- last sync visibility
- average articles per day
- error rate visibility
- feed health reporting

Marketing angle:

> Know which feeds are active, stale, noisy, or failing.

---

### 4.13 Import and export

Included:

- OPML import
- duplicate detection during import
- selective OPML export
- full user data export in JSON

Marketing angle:

> Bring your existing RSS setup with you — and keep your data portable.

---

### 4.14 Keyboard shortcuts and desktop power use

FeedFerret supports keyboard-first workflows.

Included shortcuts:

- `/` open search
- `Esc` close overlays/search
- `j` / `k` next / previous article
- `n` / `p` next / previous unread
- `s` toggle star
- `m` toggle read/unread
- `o` open original link
- `r` refresh feeds
- `Shift+S` save search
- `Shift+A` mark all as read
- `?` open shortcut help

Marketing angle:

> Fast enough for inbox-style reading and research workflows.

---

### 4.15 Email digests

FeedFerret supports periodic article digests by email.

Included:

- digest enable/disable per user
- frequency options
- day-of-week controls
- hour controls
- scope filters
- feed filters
- test digest sending
- unsubscribe links

Marketing angle:

> Let your reading list come to you.

---

### 4.16 Flexible email delivery

FeedFerret supports multiple mail delivery backends.

Included:

- SMTP configuration via admin UI
- Resend support via environment configuration
- Postmark support via environment configuration
- Mailgun support via environment configuration
- SendGrid support via environment configuration
- provider selection in server settings
- provider visibility only when environment variables are configured
- test email action from server management

Used for:

- sign-in emails
- digest emails
- transactional emails

Marketing angle:

> Use the mail stack that already fits your infrastructure.

---

### 4.17 Google Reader API compatibility

A major compatibility feature is the expanded Google Reader style API support.

Included support now covers endpoints and workflows such as:

- stream contents
- stream item contents
- stream item ids
- subscription list
- subscription edit
- quick add subscription
- tag list
- edit tag
- mark all as read
- preference list
- stream preferences
- unread counts
- token endpoint
- user info

Supported concepts include:

- reading list
- feed streams
- label streams
- read/unread state
- starred state
- label add/remove

Practical outcome:

- works better with native client ecosystems
- designed for apps like Reeder, NetNewsWire, FeedMe, ReadKit, and similar clients

Important note:

- password-based Google Reader auth is intentionally blocked for accounts using local 2FA, because those flows do not support a second-factor challenge

Marketing angle:

> Use FeedFerret as your server backend while keeping your favorite reader client.

---

### 4.18 Background sync

FeedFerret includes built-in feed refresh scheduling.

Included:

- in-process background scheduler
- configurable sync interval
- per-feed cadence support
- external sync API option
- status endpoint
- optional secret for sync endpoint protection

Marketing angle:

> Keep your feeds fresh without extra infrastructure.

---

### 4.19 Admin controls

FeedFerret includes a dedicated server management surface.

Included:

- user management
- role management
- account deletion
- registration enable/disable
- mail service enable/disable
- mail provider selection
- SMTP settings management
- test email action

Marketing angle:

> Simple enough for personal hosting, structured enough for shared deployments.

---

## 5. Design and UX Themes for Marketing

The landing page should communicate these themes clearly:

### Theme 1: Private control

- your feeds
- your server
- your users
- your data

### Theme 2: Modern reading experience

- beautiful reader
- mobile-friendly
- thumb-first controls
- dark mode and polish

### Theme 3: Power-user depth

- rules
- labels
- saved searches
- shared search feeds
- keyboard shortcuts
- health dashboards
- retention controls

### Theme 4: Self-hosting without pain

- SQLite default simplicity
- Docker deployment path
- Authelia support
- flexible mail providers
- admin UI instead of manual config only

### Theme 5: Works with your ecosystem

- PWA install support
- Google Reader API compatibility
- native RSS client support
- external mail providers
- SSO support

---

## 6. Strong Feature Buckets for Landing Page Sections

Suggested top-level landing page sections:

1. Hero
2. Social proof / product promise
3. Reading experience
4. Mobile and PWA experience
5. Organize everything
6. Power-user automation
7. Native client compatibility
8. Self-hosting and admin controls
9. Authentication and security
10. Deployment and docs
11. CTA

---

## 7. Possible Marketing Copy Angles

### Headline directions

- The self-hosted RSS reader that finally feels modern.
- Own your feeds. Enjoy your reading again.
- A beautiful RSS reader for self-hosters and power users.
- Your personal reading command center.
- Reeder-like reading ergonomics, self-hosted control.

### Supporting subheadline directions

- Read, filter, organize, and automate your feeds with a polished multi-user interface.
- FeedFerret combines modern UX, mobile-first reading, automation, and self-hosting flexibility.
- From saved searches to Google Reader API support, FeedFerret gives serious readers the tools they actually need.

---

## 8. Most Marketable Newly Added Features

These additions are especially strong for launch messaging because they significantly extend the product beyond a basic RSS reader:

- Mobile UX refactor with bottom controls and gestures
- PWA install flow and app-like mobile experience
- Saved search sharing with public pages and RSS outputs
- Expanded Google Reader API compatibility
- Optional TOTP 2FA
- Optional Authelia OIDC login
- Flexible email providers: SMTP, Resend, Postmark, Mailgun, SendGrid

These should likely be highlighted as “recently added” or “what makes FeedFerret different.”

---

## 9. Deployment and Self-Hosting Positioning

FeedFerret should be positioned as:

- simple enough for an individual homelab
- strong enough for multi-user use
- modern enough to replace older self-hosted readers
- extensible enough for advanced workflows

Key points to mention:

- SQLite out of the box
- Docker-friendly deployment
- mail provider flexibility
- Authelia compatibility
- admin controls in UI
- docs for self-hosters

---

## 10. Security and Privacy Positioning

Important messaging points:

- self-hosted deployment
- per-user isolation
- optional 2FA
- optional SSO via Authelia
- registration controls
- no dependency on a hosted SaaS account to use the product

---

## 11. Recommended Landing Page CTA Ideas

- Start self-hosting FeedFerret
- Install FeedFerret on your server
- Explore the feature set
- Use FeedFerret with your favorite RSS client
- Read smarter, host it yourself

---

## 12. Short Product Description Variants

### Short version

FeedFerret is a modern self-hosted RSS reader with multi-user support, mobile-first reading UX, automation, saved searches, PWA support, and Google Reader API compatibility.

### Medium version

FeedFerret is a polished, self-hostable RSS reader built for people who want privacy, control, and a better reading experience. It combines mobile-friendly design, labels, saved searches, automation rules, email digests, flexible authentication, and native-client compatibility in one modern app.

### Long version

FeedFerret is a self-hosted RSS platform for serious readers. It helps you collect and organize feeds, automate low-value noise away, save and share powerful searches, read comfortably on desktop and mobile, install the app as a PWA, connect external RSS clients through Google Reader API compatibility, and manage authentication through local accounts, 2FA, OAuth, or Authelia. It is designed to be powerful without feeling dated.

---

## 13. Current State Summary

FeedFerret is no longer just a basic self-hosted RSS reader.

It currently combines:

- strong reading UX
- serious mobile improvements
- installable PWA behavior
- self-hosting flexibility
- automation and search depth
- external client compatibility
- modern authentication options
- flexible server-side email infrastructure

This makes it suitable to market as a **modern self-hosted reading platform**, not just a feed list.
