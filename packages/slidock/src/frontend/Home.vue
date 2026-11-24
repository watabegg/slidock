<script setup lang="ts">
import type { Catalog, CatalogDeck } from '@slidock/slidock/client';
import type { HubHomeOptions } from './home-options.js';
import type { VNode } from 'vue';
import SlidockHome from './SlidockHome.vue';
defineProps<{
  catalog: Catalog;
  home?: HubHomeOptions;
  homeHref?: string;
  homeLabel?: string;
  deckHref?: (deck: CatalogDeck) => string;
}>();
defineSlots<{
  empty?(props: { reason: 'catalog' | 'filters' }): VNode[];
}>();
</script>
<template>
  <SlidockHome
    :catalog="catalog"
    :title="home?.title ?? homeLabel ?? 'Slidock'"
    :logo="home?.logo ?? (homeLabel && homeLabel !== 'Slidock' ? false : undefined)"
    :home-href="homeHref"
    :category-labels="home?.categoryLabels"
    :deck-href="deckHref"
  >
    <template v-if="home?.links?.length" #nav>
      <a v-for="link in home.links" :key="link.href" :href="link.href">{{ link.label }}</a>
    </template>
    <template v-if="home?.hero === true" #header>
      <section class="home-hero">
        <h1>{{ home?.title ?? homeLabel ?? 'Slidock' }}</h1>
        <p v-if="home?.description">{{ home.description }}</p>
      </section>
    </template>
    <template v-if="home?.footer" #footer>{{ home.footer }}</template>
    <template #empty="{ reason }">
      <slot name="empty" :reason="reason">
        <p class="empty-library">
          {{ reason === 'filters' ? '条件に一致するスライドがありません。' : 'スライドがありません。' }}
        </p>
      </slot>
    </template>
  </SlidockHome>
</template>
