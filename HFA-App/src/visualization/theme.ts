// Log display themes. 'light' = conventional paper-style well-log tracks
// (white tracks, grey grid, black depth annotation — Techlog / Geolog look).
export interface LogTheme {
  bg: string; trackBg: string; selTrack: string; minor: string; major: string; vgrid: string; border: string;
  text: string; dim: string; headBg: string; cursor: string; coreStroke: string; bandText: string; resFill: string;
}
export const THEMES: Record<'light' | 'dark', LogTheme> = {
  light: { bg: '#ffffff', trackBg: '#ffffff', selTrack: '#f2f7ff', minor: '#ececec', major: '#c8c8c8', vgrid: '#d6d6d6', border: '#555555', text: '#111111', dim: '#666666', headBg: '#ffffff', cursor: 'rgba(220,0,0,0.85)', coreStroke: '#000000', bandText: '#000000', resFill: '#ffe600' },
  dark: { bg: '#0c0f13', trackBg: '#0c0f13', selTrack: '#101a26', minor: '#141a21', major: '#222b36', vgrid: '#1c232c', border: '#2b333e', text: '#9aa4b2', dim: '#6b7686', headBg: '#13171d', cursor: 'rgba(255,255,255,0.7)', coreStroke: '#000000', bandText: '#0c0f13', resFill: '#e8c547' },
};
/** Colours chosen for a dark background can vanish on white — darken very light ones. */
export function themed(color: string, theme: 'light' | 'dark'): string {
  if (theme === 'dark' || !color) return color;
  const m = /^#([0-9a-f]{6})$/i.exec(color); if (!m) return color;
  const n = parseInt(m[1], 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (L > 0.85) return '#000000';
  if (L > 0.6) { const f = 0.62; return '#' + [r, g, b].map((x) => Math.round(x * f).toString(16).padStart(2, '0')).join(''); }
  return color;
}
