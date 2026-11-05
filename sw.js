// CREW — service worker.
// Приложение открывается мгновенно из кэша (в том числе без интернета), а свежая версия файлов
// подтягивается в фоне. Данные таблицы (запросы к Google Apps Script) здесь не кэшируются никогда:
// они идут POST на другой домен. Офлайн-копия данных хранится самим приложением на устройстве.
//
// ВАЖНО: при любом изменении файлов из SHELL увеличивайте номер в CACHE (crew-v5, crew-v6, crew-v7, crew-v8, crew-v9, crew-v10 …).
// Тогда новый кэш собирается целиком, а старый удаляется — файлы разных версий не смешиваются.
var CACHE = 'crew-v12';
var SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './assets/design-tokens.css', './assets/crew-mark.svg', './assets/crew-wordmark.svg', './assets/crew-wordmark-light.svg', './assets/empty-state.svg',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png', './apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  // addAll атомарен: если хоть один файл не скачался, новая версия не ставится и работает прежняя
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    var hadOld = keys.some(function (k) { return k !== CACHE; });
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }))
      .then(function () { return self.clients.claim(); })
      .then(function () { if (hadOld) notify(); });     // обновление: открытое приложение предложит «Обновить»
  }));
});

// cache-first + фоновое обновление: экран появляется сразу, файлы обновляются следом.
// Если главная страница в сети отличается от закэшированной — сообщаем приложению.
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  var isDoc = e.request.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname);
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var net = fetchWithTimeout(e.request, 15000).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          if (hit && isDoc) {
            Promise.all([hit.clone().text(), res.clone().text()]).then(function (t) {
              if (t[0] !== t[1]) notify();
            }).catch(function () {});
          }
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        // без сети: то, что есть в кэше; для открытия приложения — главная страница
        return hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error());
      });
      if (hit) e.waitUntil(net.catch(function () {}));
      return hit || net;
    })
  );
});

// плохая связь: не ждём ответ вечно
function fetchWithTimeout(req, ms) {
  if (!self.AbortController) return fetch(req);
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  return fetch(req, { signal: ctl.signal }).then(function (r) { clearTimeout(t); return r; }, function (err) { clearTimeout(t); throw err; });
}
function notify() {
  self.clients.matchAll({ type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: 'update' }); });
  });
}
