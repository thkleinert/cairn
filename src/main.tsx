import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import './index.css';
import App from './App.tsx';

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
  // Auto-apply updates: when a newly-installed worker takes control, reload
  // once so the page swaps to the fresh assets instead of waiting for a manual
  // restart. Skip the very first registration (no prior controller — that page
  // already loaded current assets), and guard against reload loops.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // A standalone/home-screen PWA doesn't re-fetch anything just from being
      // brought back to the foreground — only a genuine reload does. Proactively
      // check for a new worker whenever the app becomes visible again; if one is
      // found it activates immediately (skipWaiting) and the controllerchange
      // handler above reloads to pick up the new assets.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
