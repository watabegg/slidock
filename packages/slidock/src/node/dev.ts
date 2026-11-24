import { normalizeHubConfig } from './config.js';
import type { HubBuildOptions, NormalizedHubConfig } from './config.js';
import { startDev } from './internal/dev.mjs';

export interface HubDevOptions extends HubBuildOptions {
  port?: number;
  resolveOptions?: () => Promise<HubBuildOptions>;
  watchFiles?: string[];
}

/** Local authoring server; Slidev owns slide HMR, Vite owns the home UI. */
export async function devHub(
  options: HubDevOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const {
    port = 4174,
    resolveOptions: suppliedResolveOptions,
    watchFiles = [],
    ...buildOptions
  } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid development port');
  const resolveConfig = async (): Promise<NormalizedHubConfig> =>
    normalizeHubConfig(await (suppliedResolveOptions?.() ?? Promise.resolve(buildOptions)));
  return startDev(await normalizeHubConfig(buildOptions), port, resolveConfig, watchFiles);
}
