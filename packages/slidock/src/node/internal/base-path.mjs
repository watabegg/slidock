/** Normalize a site mount path, never an origin, query, or filesystem path. */
export function normalizeBasePath(value = '/') {
  if (typeof value !== 'string' || !value.startsWith('/'))
    throw new Error('basePath must be an absolute URL pathname such as /slides/');
  if (value === '/') return '/';
  const segments = value.slice(1).replace(/\/$/, '').split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment),
    )
  )
    throw new Error(
      'basePath must contain URL-safe path segments without queries, fragments, or traversal',
    );
  return `/${segments.join('/')}/`;
}

export function withBasePath(basePath, path = '') {
  return `${basePath}${path.replace(/^\//, '')}`;
}

/** Return a site-local pathname, or null when the request is outside this mount. */
export function stripBasePath(pathname, basePath) {
  if (basePath === '/') return pathname.startsWith('/') ? pathname : null;
  if (!pathname.startsWith(basePath)) return null;
  return `/${pathname.slice(basePath.length)}`;
}
