<script setup lang="ts">
import Home from './Home.vue';
import type { HubHomeOptions } from './home-options.js';
import { useCatalog } from './use-catalog.js';
const { catalog, pending, error, reload } = useCatalog();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeLink(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const protocol = new URL(value, 'https://slidock.invalid').protocol;
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(protocol);
  } catch {
    return false;
  }
}

function readHomeConfig(): { home?: HubHomeOptions; malformed: boolean } {
  if (typeof document === 'undefined') return { malformed: false };
  const script = document.getElementById('slidock-home-config');
  if (!script) return { malformed: false };
  if (script.tagName !== 'SCRIPT' || script.getAttribute('type') !== 'application/json')
    return { home: {}, malformed: true };

  let value: unknown;
  try {
    value = JSON.parse(script.textContent ?? '');
  } catch {
    return { home: {}, malformed: true };
  }
  if (!isRecord(value)) return { home: {}, malformed: true };

  const home: HubHomeOptions = {};
  let malformed = false;
  if (value.title !== undefined) {
    if (typeof value.title === 'string') home.title = value.title;
    else malformed = true;
  }
  if (value.hero !== undefined) {
    if (typeof value.hero === 'boolean') home.hero = value.hero;
    else malformed = true;
  }
  if (value.description !== undefined) {
    if (typeof value.description === 'string') home.description = value.description;
    else malformed = true;
  }
  if (value.logo !== undefined) {
    if (value.logo === false || (typeof value.logo === 'string' && value.logo.length > 0))
      home.logo = value.logo;
    else malformed = true;
  }
  if (value.footer !== undefined) {
    if (typeof value.footer === 'string') home.footer = value.footer;
    else malformed = true;
  }
  if (value.links !== undefined) {
    if (!Array.isArray(value.links)) malformed = true;
    else {
      const links = value.links.filter((link): link is { label: string; href: string } => {
        const valid = isRecord(link) &&
          typeof link.label === 'string' && link.label.length > 0 &&
          typeof link.href === 'string' && safeLink(link.href);
        if (!valid) malformed = true;
        return valid;
      });
      home.links = links;
    }
  }
  if (value.categoryLabels !== undefined) {
    if (!isRecord(value.categoryLabels)) malformed = true;
    else {
      const labels: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [id, label] of Object.entries(value.categoryLabels)) {
        if (typeof label !== 'string') malformed = true;
        else labels[id] = label;
      }
      home.categoryLabels = labels;
    }
  }
  return { home, malformed };
}

const homeConfig = readHomeConfig();
</script>
<template>
  <p v-if="homeConfig.malformed" class="home-config-error" role="alert">
    ホーム設定に問題があるため、安全な既定設定で表示しています。
  </p>
  <Home v-if="catalog" :catalog="catalog" :home="homeConfig.home">
    <template #empty="{ reason }">
      <p v-if="reason === 'filters'" class="empty-library">条件に一致するスライドがありません。</p>
      <p v-else class="empty-library">スライドがありません。</p>
    </template>
  </Home>
  <div v-else-if="error" class="catalog-state" role="alert">
    <p>資料一覧を読み込めませんでした。</p>
    <button @click="reload">再試行</button>
  </div>
  <p v-else-if="pending" class="catalog-state" role="status">読み込み中…</p>
</template>
