/* KRECK OS service worker (Build 11 "Tailgate", v9.3)
   Job: let the app OPEN with no signal. It keeps a copy of the app page, the logos, and the database
   library on the iPad. When there is signal the page is always fetched fresh, so a new build shows up
   on the next open exactly as before. The customer proposal page is never touched. */
const CACHE = "kos-shell-v9.3.2";
const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const PAGE = new URL("index.html", self.location).href;
const SHELL = [
  PAGE,
  "assets/logo-horizontal.png", "assets/logo-white.png",
  "assets/badge-catchall.png", "assets/badge-choice-2025.png", "assets/badge-google-5star.png",
  "assets/badge-hardie.png", "assets/badge-oc-platinum.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* one at a time so a single missing file never blocks the install */
    for (const u of SHELL) { try { await c.add(new Request(u, { cache: "reload" })); } catch (_) {} }
    /* the library is loaded by a plain script tag from another site; keep our own copy of it */
    try { const r = await fetch(new Request(LIB, { mode: "no-cors", cache: "reload" })); await c.put(LIB, r); } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) { if (k !== CACHE) await caches.delete(k); }
    await self.clients.claim();
  })());
});

function withTimeout(p, ms) {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("slow")), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  /* the database library: use our stored copy first, refresh it quietly in the background */
  if (req.url === LIB || url.href.indexOf("cdn.jsdelivr.net/npm/@supabase/supabase-js") >= 0) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(LIB);
      const net = fetch(new Request(LIB, { mode: "no-cors" })).then((r) => { if (r && (r.ok || r.type === "opaque")) c.put(LIB, r.clone()); return r; });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;                 /* database, CompanyCam, etc: not ours */
  if (url.pathname.endsWith("/proposal.html")) return;             /* customers always get the live page */
  if (url.pathname.endsWith("/sw.js")) return;

  /* the app page: fresh when there is signal, stored copy when there is not */
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html")) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const r = await withTimeout(fetch(new Request(PAGE, { cache: "no-cache" })), 5000);
        if (r && r.ok) { c.put(PAGE, r.clone()); return r; }
        throw new Error("bad response");
      } catch (_) {
        const hit = await c.match(PAGE, { ignoreSearch: true });
        if (hit) return hit;
        return fetch(req);
      }
    })());
    return;
  }

  /* logos and other files in assets/: stored copy first */
  if (url.pathname.indexOf("/assets/") >= 0) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r && r.ok) c.put(req, r.clone());
      return r;
    })());
  }
});
