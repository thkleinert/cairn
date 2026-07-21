import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import './index.css';
import App from './App.tsx';
import { toast } from './lib/toast';

// Inject Google Maps JS API with the key from env
const gmKey = import.meta.env.VITE_GOOGLE_PLACES_KEY as string;
if (gmKey) {
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${gmKey}&libraries=places`;
  s.async = true;
  s.defer = true;
  s.onload = () => window.dispatchEvent(new Event('gmaps-loaded'));
  document.head.appendChild(s);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Surface app updates — the new SW activates immediately (skipWaiting),
      // but the running page keeps old assets until reloaded
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('App updated — restart to get the latest version', 'info');
          }
        });
      });

      // A standalone/home-screen PWA doesn't re-fetch anything just from
      // being brought back to the foreground — only a genuine reload does.
      // Proactively check for a new service worker whenever the app
      // becomes visible again, so the update toast above shows up without
      // needing to fully quit and relaunch first.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
