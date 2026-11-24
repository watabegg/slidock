import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { resolveRuntime } from './runtime.js';
import { compileContract, stableJson } from './static-runtime.js';

// Each deck gets its own compiler process so theme/setup state cannot cross decks.
const input = JSON.parse(process.argv[2]) as {
  dependencyRoot: string;
  entry: string;
  theme: string;
  base: string;
  viteCacheDir: string;
};
const { api, cliRequire } = await resolveRuntime(input.dependencyRoot);
const { watch } = await import(pathToFileURL(cliRequire.resolve('chokidar')).href);
if (typeof api.createServer !== 'function')
  throw new Error('Slidev createServer API is unavailable');
type Options = Parameters<typeof compileContract>[0] & {
  data: Parameters<typeof compileContract>[0]['data'] & { slides: unknown[] };
};
type DevServer = { listen(): Promise<void>; close(): Promise<void>; httpServer: Server };
const createServer = api.createServer as (
  options: unknown,
  vite: unknown,
  hooks: unknown,
) => Promise<DevServer>;
const entryOptions = {
  entry: input.entry,
  theme: input.theme,
  base: input.base,
  routerMode: 'history',
};
let server: DevServer | undefined;
let port = 0;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let restarting = Promise.resolve();
async function start() {
  const options = (await api.resolveOptions(entryOptions, 'dev')) as Options;
  const signature = stableJson(compileContract(options));
  server = await createServer(
    options,
    {
      base: input.base,
      cacheDir: input.viteCacheDir,
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        watch: { usePolling: true, interval: 200 },
      },
      logLevel: 'warn',
    },
    {
      async loadData() {
        // Resolve with the profile theme on every load. Upstream CLI reloads omit
        // the --theme override and otherwise restart even for plain text edits.
        const next = (await api.resolveOptions(entryOptions, 'dev')) as Options;
        if (stableJson(compileContract(next)) !== signature) {
          restart();
          return false;
        }
        return next.data;
      },
    },
  );
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Slidev did not bind a TCP port');
  port = address.port;
}
function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    restarting = restarting
      .then(async () => {
        if (stopping) return;
        await server?.close();
        server = undefined;
        await start();
      })
      .catch((error: unknown) => console.error(error));
  }, 100);
}
await start();
// Setup changes require a new plugin graph; failed restarts remain recoverable.
const watcher = watch(dirname(input.entry), {
  usePolling: true,
  interval: 200,
  ignoreInitial: true,
  ignored: (file: string) => /(?:^|[/\\])(?:node_modules|\.git|\.cache)(?:[/\\]|$)/.test(file),
});
watcher.on('all', (_event: string, file: string) => {
  if (
    !server ||
    /(?:^|[/\\])(?:vite\.config\.|uno\.config\.|unocss\.config\.|setup[/\\])/.test(file)
  )
    restart();
});
let closing: Promise<void> | undefined;
function close() {
  if (closing) return closing;
  stopping = true;
  clearTimeout(timer);
  closing = (async () => {
    try {
      await watcher.close();
      await restarting;
      await server?.close();
    } finally {
      process.disconnect?.();
    }
  })();
  return closing;
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close();
  });
process.once('disconnect', () => {
  if (!stopping) void close();
});
process.send?.({ origin: `http://127.0.0.1:${port}` });
