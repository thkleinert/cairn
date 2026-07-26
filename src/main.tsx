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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Check for a new worker whenever the app comes back to the foreground.
      // The worker installs quietly and waits — it takes over on the next full
      // app launch, which also picks up the new assets (navigations are
      // network-first). No mid-session takeover or auto-reload: seizing a live
      // page wedged the iOS standalone PWA on the splash screen.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
