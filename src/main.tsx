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

// TEMPORARY DIAGNOSTIC — pinning down the iOS standalone-PWA bottom gap.
// Remove once we have real device numbers to work from.
window.addEventListener('load', () => {
  setTimeout(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);';
    document.body.appendChild(probe);
    const safeAreaBottom = getComputedStyle(probe).paddingBottom;
    document.body.removeChild(probe);

    const vv = window.visualViewport;
    const lines = [
      `innerHeight: ${window.innerHeight}`,
      `visualViewport: ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} offsetTop=${vv.offsetTop.toFixed(1)} scale=${vv.scale}` : 'unavailable'}`,
      `documentElement.clientHeight: ${document.documentElement.clientHeight}`,
      `screen: ${window.screen.width}x${window.screen.height} dpr=${window.devicePixelRatio}`,
      `display-mode standalone: ${window.matchMedia('(display-mode: standalone)').matches}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `navigator.standalone: ${(navigator as any).standalone}`,
      `env(safe-area-inset-bottom): ${safeAreaBottom}`,
      `--app-height: ${getComputedStyle(document.documentElement).getPropertyValue('--app-height')}`,
    ];
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:rgba(220,38,38,0.95);color:#fff;font:11px/1.5 monospace;padding:8px;white-space:pre-wrap;';
    box.textContent = lines.join('\n');
    document.body.appendChild(box);
  }, 500);
});

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
