import fs from 'node:fs';

function fail(message) {
  console.error(`PWA check failed: ${message}`);
  process.exitCode = 1;
}

const manifest = JSON.parse(fs.readFileSync('public/manifest.json', 'utf8'));
const sw = fs.readFileSync('public/sw.js', 'utf8');

for (const key of ['name', 'short_name', 'start_url', 'display', 'icons', 'screenshots', 'shortcuts']) {
  if (!manifest[key]) fail(`manifest is missing ${key}`);
}

if (!manifest.icons?.some((icon) => icon.purpose?.includes('maskable'))) fail('manifest needs a maskable icon');
if (!manifest.screenshots?.some((s) => s.form_factor === 'narrow')) fail('manifest needs a narrow screenshot');
if (!manifest.screenshots?.some((s) => s.form_factor === 'wide')) fail('manifest needs a wide screenshot');
if (!manifest.shortcuts?.some((s) => s.url?.includes('view=new'))) fail('manifest needs New Articles shortcut');
if (!manifest.shortcuts?.some((s) => s.url?.includes('view=readlater'))) fail('manifest needs Read Later shortcut');

for (const screenshot of manifest.screenshots || []) {
  const path = `public${screenshot.src}`;
  if (!fs.existsSync(path)) fail(`screenshot missing on disk: ${screenshot.src}`);
}

for (const snippet of ['push', 'notificationclick', 'setAppBadge', 'clearAppBadge', 'offline.html']) {
  if (!sw.includes(snippet)) fail(`service worker missing ${snippet}`);
}

if (!process.exitCode) console.log('PWA manifest/service-worker checks passed.');
