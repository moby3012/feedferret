"use client";

import { AppBadgeSetting } from "@/components/app-badge-setting";
import { PushNotificationSection } from "@/components/settings/sections/push-notifications";
import { DigestSection } from "@/components/settings/sections/digest";
import { NotificationChannelsSection } from "@/components/settings/sections/notification-channels";

export function NotificationSettings() {

  return (
    <>
      <PushNotificationSection />
      <AppBadgeSetting />
      <DigestSection />
      <NotificationChannelsSection />
    </>
  );
}
