export const SUBPATH_NATIVE_UNSUPPORTED_REASON = 'Native playback requires a root deployment path.';

/** Keep the native document valid for its existing root-only player contract. */
export function makeNativeUnsupportedForSubpath(document, decks, basePath) {
  if (basePath === '/') return document;

  const unsupportedById = new Map();
  for (const item of document.unsupportedDecks || []) {
    if (!unsupportedById.has(item.id)) unsupportedById.set(item.id, item);
  }
  for (const item of document.decks || []) {
    if (!unsupportedById.has(item.id)) {
      unsupportedById.set(item.id, {
        id: item.id,
        reason: SUBPATH_NATIVE_UNSUPPORTED_REASON,
      });
    }
  }
  for (const deck of decks || []) {
    if (!unsupportedById.has(deck.id)) {
      unsupportedById.set(deck.id, {
        id: deck.id,
        reason: SUBPATH_NATIVE_UNSUPPORTED_REASON,
      });
    }
  }

  return {
    ...document,
    decks: [],
    unsupportedDecks: [...unsupportedById.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  };
}
