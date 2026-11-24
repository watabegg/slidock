import type { CatalogDeck, JsonValue } from '@slidock/protocol/contracts';

export type CatalogDeckSort = 'catalog' | 'title' | 'date';

export interface SelectCatalogDecksOptions {
  query?: string;
  category?: string;
  tag?: string;
  sort?: CatalogDeckSort;
}

function searchableText(value: JsonValue | undefined): string[] {
  if (value === undefined || value === null || typeof value === 'boolean') return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(searchableText);
  return Object.values(value).flatMap(searchableText);
}

function deckTags(deck: CatalogDeck): string[] {
  return searchableText(deck.frontmatter.tags);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Filter and sort public catalog decks without mutating the catalog's configured order. */
export function selectCatalogDecks(
  decks: readonly CatalogDeck[],
  options: SelectCatalogDecksOptions = {},
): CatalogDeck[] {
  const query = options.query?.trim().toLowerCase() ?? '';
  const category = options.category ?? '';
  const tag = options.tag ?? '';
  const sort = options.sort ?? 'catalog';

  const selected = decks
    .map((deck, index) => ({ deck, index }))
    .filter(({ deck }) => {
      if (category) {
        const path = deck.categoryPath.join('/');
        if (path !== category && !path.startsWith(`${category}/`)) return false;
      }
      if (tag && !deckTags(deck).includes(tag)) return false;
      if (query) {
        const fields = [
          deck.title,
          ...searchableText(deck.frontmatter.description),
          ...searchableText(deck.frontmatter.author),
          ...deckTags(deck),
        ];
        if (!fields.some((field) => field.toLowerCase().includes(query))) return false;
      }
      return true;
    });

  if (sort === 'title') {
    selected.sort(
      (left, right) =>
        compareText(left.deck.title, right.deck.title) ||
        compareText(left.deck.id, right.deck.id) ||
        left.index - right.index,
    );
  } else if (sort === 'date') {
    const dateOf = (deck: CatalogDeck): number | undefined => {
      const date = deck.frontmatter.date;
      if (typeof date !== 'string') return undefined;
      const parsed = Date.parse(date);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    selected.sort((left, right) => {
      const leftDate = dateOf(left.deck);
      const rightDate = dateOf(right.deck);
      if (leftDate === undefined && rightDate !== undefined) return 1;
      if (leftDate !== undefined && rightDate === undefined) return -1;
      if (leftDate !== undefined && rightDate !== undefined && leftDate !== rightDate)
        return rightDate - leftDate;
      return left.index - right.index;
    });
  }

  return selected.map(({ deck }) => deck);
}
