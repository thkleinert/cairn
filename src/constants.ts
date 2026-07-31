// Shared tag color palette — used by tag creation forms and map markers
export const TAG_COLORS: Array<{ value: string; name: string }> = [
  { value: '#6366f1', name: 'Indigo' },
  { value: '#ec4899', name: 'Pink' },
  { value: '#f59e0b', name: 'Amber' },
  { value: '#10b981', name: 'Emerald' },
  { value: '#3b82f6', name: 'Blue' },
  { value: '#ef4444', name: 'Red' },
  { value: '#8b5cf6', name: 'Violet' },
  { value: '#14b8a6', name: 'Teal' },
];

// Suggested tag emoji — offered by both tag-creation forms (the tag manager
// and the picker on a place). Shared so the two can't drift apart.
export const SUGGESTED_ICONS: string[] = [
  '📍', '🍔', '📷', '🏛️', '🏖️', '🛍️', '☕', '🍷', '🏨', '🎭', '🌿', '⛪',
];
