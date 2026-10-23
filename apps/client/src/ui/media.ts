import { useSyncExternalStore } from 'react';

/** Phones either way up, and small tablets upright. Kept in step with the compact rules in styles.css. */
export const COMPACT = '(max-width: 900px), (max-height: 520px)';
/** Too narrow for every top-bar button: most fold into a menu. */
export const HUD_FOLD = '(max-width: 1720px)';
/** Touch screens: no hover, no keyboard shortcuts. */
export const TOUCH = '(pointer: coarse)';

export const matches = (query: string): boolean =>
  typeof matchMedia === 'function' && matchMedia(query).matches;

/** Whether a media query matches, kept up to date as the screen turns or resizes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => matches(query),
  );
}
