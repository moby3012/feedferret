// Desktop "Subscribe in FeedFerret" bookmarklet. It reuses the PWA
// share-target deep link (`/?sharedUrl=…`, see public/manifest.json's
// `share_target` and the handler in app/page.tsx), so a desktop click and a
// phone share sheet take exactly the same path: Add-Feed opens pre-filled and
// runs smart discovery on the page's URL.

/** Returns the `javascript:` URL to drag to the bookmarks bar. `origin` must be this instance's origin. */
export function buildBookmarkletHref(origin: string): string {
  const base = JSON.stringify(`${origin.replace(/\/+$/, "")}/?sharedUrl=`);
  return (
    "javascript:(function(){" +
    `var t=${base}+encodeURIComponent(location.href);` +
    "window.open(t,'_blank')||(location.href=t)" +
    "})()"
  );
}
