/**
 * The JoyBot mark (a J above a smile), drawn inline so it follows the theme: dark J and teal smile
 * on light, white J and cyan smile in dark mode or on a dark surface (`onDark`, e.g. the side menu).
 * Files for other uses: public/brand/.
 */
export function BrandMark({ className = 'size-7', onDark = false }: { className?: string; onDark?: boolean }) {
  return (
    <svg viewBox="8 22 184 196" className={className} aria-hidden="true">
      <path
        className={onDark ? 'fill-white' : 'fill-[#1A1A1D] dark:fill-white'}
        d="M110 30 H140 V118 C140 150 120 168 90 168 C78 168 66 165 56 160 L68 136 C74 140 82 142 88 142 C102 142 110 134 110 116 V50 H103 Z"
      />
      <path className={onDark ? 'stroke-[#67D5DF]' : 'stroke-[#1C9DAB] dark:stroke-[#67D5DF]'} d="M28 174 Q100 238 172 174" fill="none" strokeWidth="18" />
    </svg>
  );
}
