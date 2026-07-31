import { useState, useRef, useEffect } from 'react';
import { X, Trash2 } from 'lucide-react';
import { useEscapeClose } from '../hooks/useEscapeClose';
import type { PlaceImage } from '../types';

interface Props {
  images: PlaceImage[];
  startIndex: number;
  onClose: () => void;
  onRemove?: (imageId: string) => void;
}

// Full-screen swipeable viewer for the "shot ideas" gallery — native
// scroll-snap for the swipe (no JS gesture handling needed),
// tap-outside-the-photo-to-dismiss, and no library dependency.
export function ImageLightbox({ images, startIndex, onClose, onRemove }: Props) {
  const [activeIndex, setActiveIndex] = useState(startIndex);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEscapeClose(onClose);

  useEffect(() => {
    // Jump to the tapped photo instantly on mount, no smooth animation
    const el = scrollerRef.current;
    if (el) el.scrollTo({ left: startIndex * el.clientWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (images.length === 0) { onClose(); return; }
    const el = scrollerRef.current;
    if (!el) return;
    const clamped = Math.min(activeIndex, images.length - 1);
    if (clamped !== activeIndex) setActiveIndex(clamped);
    el.scrollTo({ left: clamped * el.clientWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.length]);

  const scrollToImage = (index: number) => {
    const el = scrollerRef.current;
    setActiveIndex(index);
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
  };

  const handleScroll = () => {
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(() => {
      const el = scrollerRef.current;
      if (!el || el.clientWidth === 0) return;
      const index = Math.round(el.scrollLeft / el.clientWidth);
      setActiveIndex(prev => (prev === index ? prev : index));
    }, 60);
  };

  const handleRemove = () => {
    const current = images[activeIndex];
    if (current && onRemove) onRemove(current.id);
  };

  const dismissIfBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // Bubbling reaches this root last, so stopping it here — once, for every
    // click inside the lightbox — is enough to keep taps (buttons, dots,
    // the backdrop-dismiss handlers below) from also closing the place
    // sheet this overlay is rendered inside of
    <div className="lightbox-overlay" onClick={e => e.stopPropagation()}>
      <div
        className="lightbox-scroller"
        ref={scrollerRef}
        onScroll={handleScroll}
        onClick={dismissIfBackdrop}
      >
        {images.map(img => (
          <div key={img.id} className="lightbox-slide" onClick={dismissIfBackdrop}>
            <img src={img.url} alt="" className="lightbox-image" onError={() => {}} />
          </div>
        ))}
      </div>

      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        <X size={20} />
      </button>
      {onRemove && (
        <button className="lightbox-remove" onClick={handleRemove} aria-label="Remove photo">
          <Trash2 size={17} />
        </button>
      )}
      {images.length > 1 && (
        <div className="lightbox-dots">
          {images.map((_, i) => (
            <button
              key={i}
              className={`image-dot ${i === activeIndex ? 'image-dot--active' : ''}`}
              onClick={() => scrollToImage(i)}
              aria-label={`Photo ${i + 1} of ${images.length}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
