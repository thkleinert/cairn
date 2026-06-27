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
  document.head.appendChild(s);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
