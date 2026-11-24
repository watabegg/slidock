const safeSegment = /^[A-Za-z0-9._~-]+$/u;

function isSiteBasePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || !value.endsWith('/')) return false;
  if (value === '/') return true;
  const segments = value.slice(1, -1).split('/');
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..' && safeSegment.test(segment),
  );
}

/** Return the canonical site mount path embedded by Slidock, or `/` outside a site document. */
export function getSiteBasePath(): string {
  if (typeof document === 'undefined') return '/';
  try {
    const value = document.querySelector('meta[name="slidock-base"]')?.getAttribute('content');
    return isSiteBasePath(value) ? value : '/';
  } catch {
    return '/';
  }
}
