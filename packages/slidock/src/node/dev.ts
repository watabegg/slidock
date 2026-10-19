import { normalizeHubConfig } from './config.js';
import type { HubBuildOptions } from './config.js';
import { startDev } from './internal/dev.mjs';

export interface HubDevOptions extends HubBuildOptions {
  port?: number;
}

/** Local authoring server; Slidev owns slide HMR, Vite owns the home UI. */
export async function devHub(
  options: HubDevOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const { port = 4174, ...buildOptions } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid development port');
  return startDev(await normalizeHubConfig(buildOptions), port);
}
