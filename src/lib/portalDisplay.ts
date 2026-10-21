import { PORTAL_LOGO_DOMAINS } from '../constants/portalLogos';

// Portal host without the www prefix — shown on the card and used to resolve
// the downloaded favicon in public/logos/{domain}.png.
export function portalHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

export function portalLogoUrl(url: string): string | null {
  const host = portalHost(url);
  return PORTAL_LOGO_DOMAINS.has(host) ? `/logos/${host}.png` : null;
}

// Deterministic, evenly-spread hue per portal name — the monogram fallback
// must look stable across renders and reloads.
export function portalHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function portalInitials(name: string): string {
  const clean = name.replace(/\(.*?\)/g, '').trim();
  const words = clean.split(/[\s&/]+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || clean.slice(0, 2).toUpperCase()
  );
}
