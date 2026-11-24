<script setup lang="ts">
import { computed, useId } from 'vue';
import { getSiteBasePath, selectCatalogDecks } from '@slidock/slidock/client';
import type { Catalog, CatalogCategory, CatalogDeck, JsonValue } from '@slidock/slidock/client';
import type { VNode } from 'vue';
import type { CatalogDeckSort } from '@slidock/slidock/client';
import SlideCard from './SlideCard.vue';
import CategoryNav from './CategoryNav.vue';

const brandIcon = new URL('./assets/slidock.svg', import.meta.url).href;
const props = withDefaults(defineProps<{
  catalog: Catalog;
  title?: string;
  logo?: string | false;
  homeHref?: string;
  categoryLabels?: Record<string, string>;
  deckHref?: (deck: CatalogDeck) => string;
  controls?: boolean;
}>(), { title: 'Slidock', logo: undefined, controls: true });
const homeHref = computed(() => props.homeHref ?? getSiteBasePath());
const selected = defineModel<string>('category', { default: '' });
const query = defineModel<string>('query', { default: '' });
const tag = defineModel<string>('tag', { default: '' });
const sort = defineModel<CatalogDeckSort>('sort', { default: 'catalog' });
const listId = `slidock-slides-${useId()}`;
const categoryLabel = (id: string) => props.categoryLabels?.[id] ?? props.catalog.categories.find(category => category.id === id)?.name ?? id;
const decks = computed(() => selectCatalogDecks(props.catalog.decks, {
  query: query.value,
  category: selected.value,
  tag: tag.value,
  sort: sort.value,
}));
const tagValues = (value: JsonValue | undefined): string[] => {
  if (value === undefined || value === null || typeof value === 'boolean') return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(tagValues);
  return Object.values(value).flatMap(tagValues);
};
const availableTags = computed(() => {
  const values = new Set(props.catalog.decks.flatMap(deck => tagValues(deck.frontmatter.tags)));
  if (tag.value) values.add(tag.value);
  return Array.from(values).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
});
const groups = computed(() => {
  if (sort.value !== 'catalog') {
    return decks.value.length
      ? [{ id: selected.value, label: selected.value ? categoryLabel(selected.value) : '資料', decks: decks.value }]
      : [];
  }
  const result = new Map<string, CatalogDeck[]>();
  for (const deck of decks.value) {
    const category = deck.categoryPath.join('/');
    const group = result.get(category) ?? [];
    group.push(deck);
    result.set(category, group);
  }
  return Array.from(result, ([id, items]) => ({ id, label: id ? categoryLabel(id) : '未分類', decks: items }));
});
const hrefFor = (deck: CatalogDeck) => props.deckHref?.(deck) ?? deck.entry;
const selectCategory = (category: string) => { selected.value = category; };
const setQuery = (value: string) => { query.value = value; };
const setTag = (value: string) => { tag.value = value; };
const setSort = (value: CatalogDeckSort) => { sort.value = value; };
defineSlots<{
  brand?(props: { title: string; href: string }): VNode[];
  nav?(): VNode[];
  header?(): VNode[];
  toolbar?(props: {
    query: string;
    tag: string;
    sort: CatalogDeckSort;
    category: string;
    setQuery: (value: string) => void;
    setTag: (value: string) => void;
    setSort: (value: CatalogDeckSort) => void;
    setCategory: (value: string) => void;
  }): VNode[];
  sidebar?(props: { categories: CatalogCategory[]; selected: string; select: (category: string) => void }): VNode[];
  'category-heading'?(props: { id: string; label: string; decks: CatalogDeck[] }): VNode[];
  card?(props: { deck: CatalogDeck; href: string }): VNode[];
  empty?(props: { reason: 'catalog' | 'filters' }): VNode[];
  footer?(): VNode[];
}>();
</script>
<template>
  <div class="library">
    <a class="skip-link" :href="`#${listId}`">スライド一覧へ</a>
    <header class="library-header">
      <nav class="navbar" aria-label="メインナビゲーション">
        <slot name="brand" :title="title" :href="homeHref">
          <a class="brand" :href="homeHref">
            <img v-if="logo !== false" :src="logo ?? brandIcon" width="36" height="36" alt="" />
            <span>{{ title }}</span>
          </a>
        </slot>
        <a class="slides-link" :href="`#${listId}`">スライド</a>
        <div v-if="$slots.nav" class="navbar-links"><slot name="nav" /></div>
      </nav>
    </header>
    <slot name="header" />
    <div :id="listId" class="library-layout">
      <slot
        name="sidebar"
        :categories="catalog.categories"
        :selected="selected"
        :select="selectCategory"
      >
        <CategoryNav
          v-model="selected"
          :categories="catalog.categories"
          :total="catalog.decks.length"
          :labels="categoryLabels"
        />
      </slot>
      <main class="library-main" aria-label="スライド一覧">
        <div v-if="controls || $slots.toolbar" class="library-toolbar">
          <slot
            name="toolbar"
            :query="query"
            :tag="tag"
            :sort="sort"
            :category="selected"
            :set-query="setQuery"
            :set-tag="setTag"
            :set-sort="setSort"
            :set-category="selectCategory"
          >
            <div v-if="controls" class="catalog-controls">
              <label class="filter-control">
                <span>検索</span>
                <input v-model="query" type="search" aria-label="資料を検索" autocomplete="off" />
              </label>
              <label class="filter-control">
                <span>タグ</span>
                <select v-model="tag" aria-label="タグで絞り込み">
                  <option value="">すべてのタグ</option>
                  <option v-for="value in availableTags" :key="value" :value="value">
                    {{ value }}
                  </option>
                </select>
              </label>
              <label class="filter-control">
                <span>並び順</span>
                <select v-model="sort" aria-label="並び替え">
                  <option value="catalog">登録順</option>
                  <option value="title">タイトル順</option>
                  <option value="date">日付順</option>
                </select>
              </label>
            </div>
          </slot>
        </div>
        <div class="category-groups" aria-live="polite">
          <section
            v-for="group in groups"
            :key="group.id"
            class="deck-group"
            :aria-label="group.label"
          >
            <div class="section-heading">
              <slot
                name="category-heading"
                :id="group.id"
                :label="group.label"
                :decks="group.decks"
              >
                <h2>{{ group.label }}</h2>
                <span>{{ group.decks.length }}</span>
              </slot>
            </div>
            <div class="deck-grid">
              <template v-for="deck in group.decks" :key="deck.id">
                <slot name="card" :deck="deck" :href="hrefFor(deck)">
                  <SlideCard :deck="deck" :href="hrefFor(deck)" />
                </slot>
              </template>
            </div>
          </section>
        </div>
        <template v-if="!decks.length">
          <slot name="empty" :reason="catalog.decks.length ? 'filters' : 'catalog'">
            <p class="empty-library">
              {{ catalog.decks.length ? '条件に一致するスライドがありません。' : 'スライドがありません。' }}
            </p>
          </slot>
        </template>
      </main>
    </div>
    <footer v-if="$slots.footer" class="library-footer"><slot name="footer" /></footer>
  </div>
</template>
