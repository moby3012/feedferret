import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Accessibility Statement — FeedFerret",
  description: "FeedFerret accessibility features, known limitations, and how to provide feedback.",
};

export default function AccessibilityPage() {
  return (
    <main id="main-content" className="min-h-screen bg-background px-4 py-12 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl prose prose-neutral dark:prose-invert">
        <h1>Accessibility Statement</h1>
        <p className="lead">
          FeedFerret is committed to making its interface accessible to everyone, including users
          who rely on assistive technologies. Our target is <strong>WCAG 2.2 Level AA</strong>{" "}
          conformance.
        </p>

        <h2>Features</h2>
        <ul>
          <li>
            <strong>Skip link:</strong> A &ldquo;Skip to content&rdquo; link appears at the top of
            every page when focused, allowing keyboard users to bypass navigation.
          </li>
          <li>
            <strong>ARIA landmarks:</strong> The sidebar uses <code>role=&quot;navigation&quot;</code>,
            the article list and reader use <code>role=&quot;region&quot;</code> with descriptive
            labels.
          </li>
          <li>
            <strong>Keyboard shortcuts:</strong> All major actions can be performed via keyboard
            shortcuts. Press <kbd>?</kbd> anywhere in the app to see the full list.
          </li>
          <li>
            <strong>Keyboard navigation in article lists:</strong> Article cards are focusable and
            activatable with <kbd>Enter</kbd> or <kbd>Space</kbd>.
          </li>
          <li>
            <strong>Screen reader live regions:</strong> Unread article counts and search result
            counts are announced via <code>aria-live</code> regions.
          </li>
          <li>
            <strong>Reduced motion:</strong> All animations respect the
            <code>prefers-reduced-motion</code> media query. Users who prefer reduced motion will
            see no decorative animations.
          </li>
          <li>
            <strong>Icon button labels:</strong> All icon-only buttons carry an{" "}
            <code>aria-label</code> so screen readers can identify their purpose.
          </li>
          <li>
            <strong>Semantic article structure:</strong> Article headers use proper{" "}
            <code>&lt;h1&gt;</code>, author information uses <code>&lt;address&gt;</code>, and
            publication dates use <code>&lt;time&gt;</code>.
          </li>
          <li>
            <strong>Dark mode:</strong> Full dark-mode support via the system preference or the
            in-app toggle.
          </li>
          <li>
            <strong>Focus management:</strong> Dialogs (Radix UI) trap focus and restore it to
            the trigger element on close.
          </li>
          <li>
            <strong>Toggle state:</strong> Toggle buttons (starred, read-later, read/unread, filter)
            use <code>aria-pressed</code> to communicate state to assistive technologies.
          </li>
        </ul>

        <h2>Known Limitations</h2>
        <ul>
          <li>
            Drag-and-drop feed reordering (via <code>@dnd-kit</code>) provides keyboard sensors
            but screen-reader announcements during drag operations have not been fully validated.
          </li>
          <li>
            Contrast for some muted-foreground decorative text elements may fall below the 4.5:1
            ratio for normal text at certain accent color configurations.
          </li>
          <li>
            The 200%-zoom layout has not been formally audited on all screen combinations.
          </li>
          <li>
            The application is currently only available in English; internationalization (i18n)
            is on the roadmap.
          </li>
        </ul>

        <h2>Ongoing Work</h2>
        <p>
          We are actively working on the following accessibility improvements as part of our
          pre-launch sprint:
        </p>
        <ul>
          <li>Automated accessibility testing with <code>axe-core</code> in CI</li>
          <li>Reader font-size preference setting</li>
          <li>Full contrast audit and remediation</li>
          <li>Roving tabindex for the feed sidebar list</li>
        </ul>

        <h2>Feedback &amp; Contact</h2>
        <p>
          If you encounter any accessibility barriers, please{" "}
          <a
            href="https://github.com/moby3012/feedferret/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            open an issue on GitHub
          </a>
          . Please describe what you were trying to do, the assistive technology you use, and the
          browser/platform. We aim to respond within 5 business days.
        </p>

        <h2>Technical Specifications</h2>
        <p>FeedFerret is built with:</p>
        <ul>
          <li>Next.js (React) — semantic HTML output</li>
          <li>Radix UI — accessible primitives for dialogs, dropdowns, and navigation</li>
          <li>Tailwind CSS — utility-first styling with responsive design</li>
          <li>
            <code>eslint-plugin-jsx-a11y</code> — static analysis for accessibility issues
          </li>
        </ul>

        <p className="text-sm text-muted-foreground mt-12">
          Last updated: May 2026 &mdash;{" "}
          <Link href="/" className="underline">
            Back to app
          </Link>
        </p>
      </article>
    </main>
  );
}
