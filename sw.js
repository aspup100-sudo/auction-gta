// 경매 GTA 서비스 워커: 온라인이면 항상 최신 index.html을 받고, 끊기면 저장해 둔 파일로 열어요.
const CACHE = "auction-gta-v187";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache" }).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match("./index.html")))
  );
});
// 콕 알림 (Web Push): 게임이 꺼져 있어도 친구가 찌르면 폰에 알림. 눌러서 열면 그 친구가 있는 채널을 보여 준다.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) {}
  const from = String(d.from || "친구").slice(0, 20), ch = Number(d.ch) || 0;
  const url = "./?poke=" + encodeURIComponent(from) + (ch ? "&ch=" + ch : "");
  e.waitUntil(self.registration.showNotification("👉 " + from + "님이 콕 찔렀어요!", {
    body: ch ? "나랑 놀자~ 채널 " + ch + "에서 기다릴게! (경매 GTA)" : "나랑 놀자~ (경매 GTA)",
    tag: "poke-" + from, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", vibrate: [80, 60, 80], data: { url, from, ch }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close(); const d = e.notification.data || {};
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(l => {
    if (l.length) { if (d.from) l[0].postMessage({ t: "poke", from: d.from, ch: d.ch }); return l[0].focus(); }
    return clients.openWindow(d.url || "./");
  }));
});
