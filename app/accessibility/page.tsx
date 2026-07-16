import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
  title: "Accessibility Statement — FeedFerret",
  description: "FeedFerret accessibility features, known limitations, and how to provide feedback.",
};

export default async function AccessibilityPage() {
  const t = await getTranslations("accessibility");

  return (
    <main id="main-content" className="min-h-dvh bg-background px-4 py-12 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl prose prose-neutral dark:prose-invert">
        <h1>{t("title")}</h1>
        <p className="lead">
          {t("commitment")}
        </p>

        <h2>{t("features.title")}</h2>
        <ul>
          <li>{t("features.skipLink")}</li>
          <li>{t("features.ariaLandmarks")}</li>
          <li>{t("features.keyboardShortcuts")}</li>
          <li>{t("features.keyboardNavigation")}</li>
          <li>{t("features.liveRegions")}</li>
          <li>{t("features.reducedMotion")}</li>
          <li>{t("features.iconLabels")}</li>
          <li>{t("features.semanticStructure")}</li>
          <li>{t("features.darkMode")}</li>
          <li>{t("features.focusManagement")}</li>
          <li>{t("features.toggleState")}</li>
        </ul>

        <h2>{t("knownLimitations.title")}</h2>
        <ul>
          <li>{t("knownLimitations.dragDrop")}</li>
          <li>{t("knownLimitations.contrast")}</li>
          <li>{t("knownLimitations.zoom")}</li>
          <li>{t("knownLimitations.i18n")}</li>
        </ul>

        <h2>{t("ongoingWork.title")}</h2>
        <p>{t("ongoingWork.description")}</p>
        <ul>
          <li>{t("ongoingWork.axeCore")}</li>
          <li>{t("ongoingWork.fontSize")}</li>
          <li>{t("ongoingWork.contrastAudit")}</li>
          <li>{t("ongoingWork.roving")}</li>
        </ul>

        <h2>{t("feedback.title")}</h2>
        <p>
          {t("feedback.description")}{" "}
          <a
            href="https://github.com/moby3012/feedferret/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("feedback.openGithubIssue")}
          </a>
        </p>

        <h2>{t("technicalSpecs.title")}</h2>
        <p>{t("technicalSpecs.builtWith")}</p>
        <ul>
          <li>{t("technicalSpecs.nextJs")}</li>
          <li>{t("technicalSpecs.radixUi")}</li>
          <li>{t("technicalSpecs.tailwind")}</li>
          <li>{t("technicalSpecs.eslint")}</li>
        </ul>

        <p className="text-sm text-muted-foreground mt-12">
          {t("lastUpdated")} &mdash;{" "}
          <Link href="/" className="underline">
            {t("backToApp")}
          </Link>
        </p>
      </article>
    </main>
  );
}
