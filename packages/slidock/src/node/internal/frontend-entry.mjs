import { createRequire } from 'node:module';
import { join } from 'node:path';

export const frontendEntryId = '/@slidock/home-entry.js';
export const frontendEntryResolvedId = '\0slidock:home-entry';

export function resolveFrontendVue(frontendEntry) {
  try {
    return createRequire(frontendEntry).resolve('vue/dist/vue.runtime.esm-bundler.js');
  } catch {
    return createRequire(import.meta.url).resolve('vue/dist/vue.runtime.esm-bundler.js');
  }
}

/** Keep mounting boilerplate inside the framework; Vue owns component HMR. */
export function createFrontendEntryPlugin(getOptions) {
  return {
    name: 'slidock:home-entry',
    resolveId(id) {
      if (id === frontendEntryId) return frontendEntryResolvedId;
    },
    load(id) {
      if (id !== frontendEntryResolvedId) return;
      const { frontendEntry, frontendRoot } = getOptions();
      if (!frontendEntry.endsWith('.vue')) return `import ${JSON.stringify(frontendEntry)};`;
      return [
        `import { createApp } from 'vue';`,
        `import Page from ${JSON.stringify(frontendEntry)};`,
        `import ${JSON.stringify(join(frontendRoot, 'style.css'))};`,
        `import ${JSON.stringify(join(frontendRoot, 'site.css'))};`,
        `createApp(Page).mount('#app');`,
      ].join('\n');
    },
  };
}
