// Scramjet service worker. Everything under /scramjet/ is a proxied URL: the
// worker fetches it through the transport (epoxy over Wisp) and rewrites the
// response so the page keeps working inside this origin. All other requests
// (the UI, /api/*) pass straight through.
importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// Take control of open tabs immediately so the first visit works without a reload.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function handle(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handle(event));
});
