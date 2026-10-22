// 경매 GTA 서비스 워커: 온라인이면 항상 최신 index.html을 받고, 끊기면 저장해 둔 파일로 열어요.
const CACHE = "auction-gta-maint1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== "auction-gta-admin").map(k => caches.delete(k)))).then(() => self.clients.claim())); });
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
  if (d.t === "crowd") { // v267 운영자 기기: 한 채널에 사람이 많을 때
    e.waitUntil(self.registration.showNotification("👥 " + String(d.where || "채널") + "에 " + (Number(d.n) || 0) + "명이 모였어요", { body: "20명이 넘으면 버벅거릴 수 있어요. 계속 많으면 서버 요금제나 위치 보내는 횟수를 손봐야 해요.", tag: "crowd", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./" } }));
    return;
  }
  if (d.t === "don") { // v294 운영자 기기: Ko-fi 후원이 들어왔을 때
    e.waitUntil(self.registration.showNotification("후원이 들어왔어요", { body: String(d.from || "누군가") + " · " + String(d.amt || "") + " " + String(d.cur || "") + (d.code ? "\n" + d.code + " 용돈 주기 열림" : "\n코드 없음 · 후원 목록에서 열어 주세요"), tag: "don", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./" } }));
    return;
  }
  if (d.t === "report") { // v267 운영자 기기: 채팅 신고 알림 (눌러서 의견함 열기)
    e.waitUntil(self.registration.showNotification("🚩 채팅 신고가 들어왔어요", { body: String(d.who || "누군가") + "님 신고" + (d.ch ? " · 채널 " + d.ch : "") + "\n" + String(d.text || "").slice(0, 80), tag: "report", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { report: 1 } }));
    return;
  }
  const from = String(d.from || "친구").slice(0, 20), ch = Number(d.ch) || 0;
  const url = "./?poke=" + encodeURIComponent(from) + (ch ? "&ch=" + ch : "");
  e.waitUntil(self.registration.showNotification("👉 " + from + "님이 콕 찔렀어요!", {
    body: ch ? "나랑 놀자~ 채널 " + ch + "에서 기다릴게! (경매 GTA)" : "나랑 놀자~ (경매 GTA)",
    tag: "poke-" + from, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", vibrate: [80, 60, 80], data: { url, from, ch }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close(); const d = e.notification.data || {};
  if (d.report) { e.waitUntil(caches.open("auction-gta-admin").then(c => c.match("./__fbadmin")).then(r => r ? r.json() : {}).catch(() => ({})).then(o => clients.openWindow(o.url || "./"))); return; } // 의견함 주소는 운영자 기기에만 저장돼 있다
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(l => {
    if (l.length) { if (d.from) l[0].postMessage({ t: "poke", from: d.from, ch: d.ch }); return l[0].focus(); }
    return clients.openWindow(d.url || "./");
  }));
});
