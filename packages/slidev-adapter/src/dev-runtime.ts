import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './runtime.js';

/** Own the lifetime of a deck's isolated Slidev development runtime. */
export async function startSlidevDev(options: {
  dependencyRoot: string;
  entry: string;
  theme: string;
  base: string;
}) {
  // Vite otherwise shares its optimizeDeps cache across Slidev child processes
  // using the same dependency root. The parent owns this temporary cache so it
  // can remove it even if the worker exits before completing shutdown.
  const viteCacheDir = await mkdtemp(join(tmpdir(), 'slidock-vite-cache-'));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./dev-worker.js', import.meta.url)),
      JSON.stringify({ ...options, viteCacheDir }),
    ],
    {
      cwd: options.dependencyRoot,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  let exited = false;
  const completed = new Promise<void>((resolve) => {
    child.once('error', () => {
      exited = true;
      resolve();
    });
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream!.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-6000);
    });
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      if (!exited) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        timer.unref();
        await completed;
        clearTimeout(timer);
      }
      await rm(viteCacheDir, { recursive: true, force: true });
    })();
    return closing;
  }
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Slidev dev server timed out: ${output}`)),
        90_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        child.off('error', failed);
        child.off('exit', ended);
        child.off('message', ready);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const ended = () => failed(new Error(`Slidev dev server exited: ${output}`));
      const ready = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'origin' in message &&
          typeof message.origin === 'string'
        ) {
          cleanup();
          resolve(message.origin);
        }
      };
      child.once('error', failed);
      child.once('exit', ended);
      child.on('message', ready);
    });
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function readDevDeck(options: {
  dependencyRoot: string;
  entry: string;
  theme: string;
}) {
  const runtime = await resolveRuntime(options.dependencyRoot);
  const resolved = (await runtime.api.resolveOptions(
    { entry: options.entry, theme: options.theme, routerMode: 'history' },
    'dev',
  )) as {
    data: {
      headmatter: Record<string, unknown>;
      config: { title?: string };
      slides: unknown[];
      watchFiles: Record<string, unknown>;
      markdownFiles: Record<string, { raw: string }>;
    };
  };
  const data = resolved.data;
  return {
    title: String(data.config.title || data.headmatter.title || ''),
    headmatter: data.headmatter,
    pages: data.slides.length,
    watchFiles: Object.keys(data.watchFiles),
    sources: Object.entries(data.markdownFiles).map(([file, value]) => [file, value.raw]),
    runtimeVersion: runtime.cliVersion,
  };
}
