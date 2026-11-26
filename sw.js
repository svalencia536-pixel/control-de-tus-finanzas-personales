/* Este archivo corre fuera de la página: sigue vivo aunque la app esté cerrada,
   y es lo que permite que llegue el recordatorio de la noche. */

const ICONO = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
     <rect width="64" height="64" rx="14" fill="#143257"/>
     <rect x="14" y="34" width="8" height="16" rx="2" fill="#5598e7"/>
     <rect x="28" y="26" width="8" height="24" rx="2" fill="#3987e5"/>
     <rect x="42" y="15" width="8" height="35" rx="2" fill="#1baf7a"/>
   </svg>`);

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = { titulo: 'Finanzas FVR', cuerpo: 'Recuerda registrar lo del día.' };
  try { if (e.data) d = { ...d, ...e.data.json() }; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.titulo, {
    body: d.cuerpo,
    icon: ICONO,
    badge: ICONO,
    tag: 'recordatorio-diario',   // reemplaza al anterior en vez de apilarse
    renotify: true,
    data: { url: '/' }
  }));
});

/* Al tocar la notificación: si la app ya está abierta se trae al frente,
   y si no, se abre. Así no quedan varias copias dando vueltas. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abiertas) {
      if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
