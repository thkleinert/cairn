import { Component, Suspense, type ReactNode } from 'react';
import { MapPin } from 'lucide-react';

// Wraps the lazy-loaded map: spinner while the chunk loads, and a contained
// retry UI if it fails (weak connection, or deploy skew the auto-reload in
// main.tsx couldn't paper over). Without this a rejected lazy import unmounts
// the whole app tree, not just the map.
export class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="map-load-error">
          <MapPin size={32} color="var(--color-muted)" />
          <p>Couldn't load the map</p>
          <button className="btn-secondary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <Suspense fallback={<div className="loading-spinner" />}>
        {this.props.children}
      </Suspense>
    );
  }
}
