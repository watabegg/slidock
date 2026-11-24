import { onMounted, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { getCatalog } from '@slidock/slidock/client';
import type { Catalog, CatalogSource } from '@slidock/slidock/client';

/** Fetch on mount; reactive sources reload and superseded/unmounted requests are cancelled. */
export function useCatalog(source?: MaybeRefOrGetter<CatalogSource | undefined>) {
  const catalog = shallowRef<Catalog | null>(null);
  const pending = ref(false);
  const error = shallowRef<unknown>(null);
  let controller: AbortController | undefined;
  let generation = 0;
  let disposed = false;

  async function load(preserveCatalog = false): Promise<void> {
    if (disposed) return;
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    pending.value = true;
    error.value = null;
    if (!preserveCatalog) catalog.value = null;
    try {
      const result = await getCatalog(toValue(source), { signal: controller.signal });
      if (current === generation) catalog.value = result;
    } catch (cause) {
      if (current === generation) error.value = cause;
    } finally {
      if (current === generation) pending.value = false;
    }
  }

  const reload = () => load();
  const catalogChanged = () => {
    if (toValue(source) === undefined) void load(true);
  };
  onMounted(() => {
    window.addEventListener('slidock:catalog-update', catalogChanged);
    watch(
      () => toValue(source),
      () => {
        void reload();
      },
      { immediate: true },
    );
  });
  onScopeDispose(() => {
    if (typeof window !== 'undefined')
      window.removeEventListener('slidock:catalog-update', catalogChanged);
    disposed = true;
    generation++;
    controller?.abort();
  });
  return { catalog, pending, error, reload };
}
