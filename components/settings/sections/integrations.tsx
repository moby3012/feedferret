"use client";

import { AiSummarySection } from "@/components/settings/sections/ai-summary";
import { ContentFetchSection } from "@/components/settings/sections/content-fetch";
import { ExportDestinationsSection } from "@/components/settings/sections/export-destinations";
import { SyncTutorialSection } from "@/components/settings/sections/sync-tutorial";

export function IntegrationSettings() {

  return (
    <>
      <AiSummarySection />
      <ContentFetchSection />
      <ExportDestinationsSection />
      <SyncTutorialSection />
    </>
  );
}
