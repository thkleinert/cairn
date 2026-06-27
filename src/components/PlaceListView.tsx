import { CheckCircle, Circle, MapPin } from 'lucide-react';
import type { Place, Tag } from '../types';

interface Props {
  places: Place[];
  activeTags: string[];
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
}

export function PlaceListView({ places, activeTags, allTags, onSelectPlace }: Props) {
  const filtered = activeTags.length === 0
    ? places
    : places.filter(p => (p.tags ?? []).some(t => activeTags.includes(t.id)));

  if (filtered.length === 0) {
    return (
      <div className="empty-state list-empty">
        <MapPin size={40} color="var(--color-muted)" />
        <p>{activeTags.length > 0 ? 'No places match this filter' : 'No places yet — search to add one'}</p>
      </div>
    );
  }

  return (
    <ul className="place-list">
      {filtered.map(place => {
        const isVisited = place.status === 'visited';
        return (
          <li key={place.id}>
            <button className="place-list-item" onClick={() => onSelectPlace(place)}>
              {place.image_url && (
                <img src={place.image_url} alt="" className="place-list-thumb" />
              )}
              <div className="place-list-body">
                <div className="place-list-top">
                  {isVisited
                    ? <CheckCircle size={16} color="var(--color-success)" />
                    : <Circle size={16} color="var(--color-muted)" />
                  }
                  <span className="place-list-name">{place.name}</span>
                </div>
                {place.address && <p className="place-list-address">{place.address}</p>}
                {(place.tags ?? []).length > 0 && (
                  <div className="place-list-tags">
                    {(place.tags ?? []).map(tag => {
                      const full = allTags.find(t => t.id === tag.id);
                      return (
                        <span
                          key={tag.id}
                          className="tag-pill"
                          style={{ background: full?.color ?? '#6366f1' }}
                        >
                          {full?.name ?? tag.name}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
