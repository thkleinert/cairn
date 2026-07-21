interface CairnIconProps {
  size?: number;
  color?: string;
}

export function CairnIcon({ size = 32, color = 'currentColor' }: CairnIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill={color} xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="16" cy="24" rx="11" ry="4.2" transform="rotate(-3 16 24)" />
      <ellipse cx="15.5" cy="17.5" rx="8" ry="3.3" transform="rotate(5 15.5 17.5)" />
      <ellipse cx="16.5" cy="12" rx="5.5" ry="2.5" transform="rotate(-6 16.5 12)" />
      <ellipse cx="16" cy="8" rx="3" ry="1.7" transform="rotate(4 16 8)" />
    </svg>
  );
}
