const CACHE='stacklens-v0.3.1-white-blue-assets';
const ASSETS=['./','./index.html','./style.css?v=0.3.1','./runtime.js','./decoder.js','./engine.js','./execution.js','./architectures.js','./examples.js','./app.js','./icon.svg?v=0.3.1','./manifest.webmanifest?v=0.3.1'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('stacklens-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request).then(cached=>cached||Response.error())));
});
