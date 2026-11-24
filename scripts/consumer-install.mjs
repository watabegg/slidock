import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// Retry individual registry requests so failed lifecycle scripts still fail immediately.
export async function configureInstallRetries(directory, manager) {
  if (manager === 'pnpm') {
    await appendFile(
      join(directory, 'pnpm-workspace.yaml'),
      '\nfetchRetries: 4\nfetchRetryMintimeout: 1000\nfetchRetryMaxtimeout: 10000\n',
    );
    return [];
  }
  return ['--fetch-retries=4', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=10000'];
}
