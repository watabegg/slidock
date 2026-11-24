import { mkdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, readSiteBasePath } from './internal/serve.mjs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildHub, type BuildResult } from './build.js';
import { HubBuildError, normalizeHubConfig } from './config.js';
import { devHub } from './dev.js';
import { loadProject, type LoadProjectOptions } from './project.js';

type Command = 'create' | 'dev' | 'build' | 'preview' | 'check';
type Parsed = ReturnType<typeof parseArgs>;

class ProjectCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'ProjectCliError';
  }
}

const commandNames: Command[] = ['create', 'dev', 'build', 'preview', 'check'];

function usage(command?: string): string {
  if (command === 'create') return 'Usage: slidock create [directory] [--json]';
  if (command === 'dev') return 'Usage: slidock dev [--config PATH] [--port 4174] [--json]';
  if (command === 'build') return 'Usage: slidock build [--config PATH] [--json]';
  if (command === 'preview')
    return 'Usage: slidock preview [--config PATH] [--port 4174] [--host 127.0.0.1] [--json]';
  if (command === 'check') return 'Usage: slidock check [--config PATH] [--json]';
  return 'Usage: slidock <create|dev|build|preview|check> [options]';
}

function inputError(message: string, code = 'INVALID_ARGUMENTS'): never {
  throw new ProjectCliError(code, message, 2);
}

function runtimeError(message: string, code = 'RUNTIME_ERROR'): never {
  throw new ProjectCliError(code, message, 1);
}

function parseCommand(command: string, args: string[]): Parsed {
  const commandOptions = {
    config: { type: 'string' as const },
    port: { type: 'string' as const },
    host: { type: 'string' as const },
    json: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
    version: { type: 'boolean' as const },
  };
  try {
    return parseArgs({
      args,
      options: commandOptions,
      strict: true,
      allowPositionals: true,
      allowNegative: false,
    });
  } catch {
    inputError(`invalid slidock ${command} arguments`);
  }
}

function flagString(values: Parsed['values'], name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    inputError(`--${name} requires a non-empty value`);
  return value;
}

function portNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/u.test(value)) inputError('--port must be an integer from 0 through 65535');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535)
    inputError('--port must be an integer from 0 through 65535');
  return parsed;
}

function cliCommand(args: string[]): { command?: string; rest: string[] } {
  if (args[0] === '--json') {
    if (args.length === 1 || args[1]?.startsWith('-')) return { rest: args };
    return { command: args[1], rest: args.slice(2) };
  }
  if (args[0]?.startsWith('-')) return { rest: args };
  if (args.length === 0) return { rest: [] };
  return { command: args[0], rest: args.slice(1) };
}

function outputSuccess(command: string, result: unknown, json: boolean, human: string): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, command, result })}\n`);
  else process.stderr.write(`${human}\n`);
}

function outputFailure(command: string, error: unknown, json: boolean): void {
  const code =
    error instanceof ProjectCliError
      ? error.code
      : error instanceof HubBuildError
        ? error.code
        : 'RUNTIME_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  if (json)
    process.stdout.write(`${JSON.stringify({ ok: false, command, error: { code, message } })}\n`);
  else process.stderr.write(`${command}: ${message}\n`);
  process.exitCode =
    error instanceof ProjectCliError
      ? error.exitCode
      : error instanceof HubBuildError && error.code === 'CONFIG'
        ? 2
        : error instanceof SyntaxError
          ? 2
          : 1;
}

function optionLoad(cwd: string, config: string | undefined): LoadProjectOptions {
  return { root: cwd, ...(config === undefined ? {} : { config }) };
}

function projectOutputPath(project: Awaited<ReturnType<typeof loadProject>>): string {
  const base = project.options.baseDir ?? project.root;
  const output = project.options.outDir ?? './dist';
  return isAbsolute(output) ? resolve(output) : resolve(base, output);
}

async function checkProject(project: Awaited<ReturnType<typeof loadProject>>) {
  const config = await normalizeHubConfig(project.options);
  return {
    root: project.root,
    ...(project.configPath === undefined ? {} : { configPath: project.configPath }),
    deckCount: config.decks.length,
    deckIds: config.decks.map((deck) => deck.id),
    sourceRoot: config.sourceRoot,
    outDir: config.outDir,
    theme: config.theme,
  };
}

type GroupSummary = {
  id: string;
  runtimeVersion: string;
  theme: string;
  deckIds: string[];
  reason: 'compatible' | 'isolated' | 'default';
};

function buildGroups(result: BuildResult): GroupSummary[] {
  const diagnostics = result.diagnostics as typeof result.diagnostics & {
    groupSummary?: GroupSummary[];
  };
  return (diagnostics.groupSummary ?? []).map((group) => ({
    id: group.id,
    runtimeVersion: group.runtimeVersion,
    theme: group.theme,
    deckIds: [...group.deckIds],
    reason: group.reason,
  }));
}

function safePackageName(directory: string): string {
  const name = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return name && !name.startsWith('.') ? name : 'slidock-project';
}

async function frameworkVersion(): Promise<string> {
  const packageUrl = new URL('../../package.json', import.meta.url);
  try {
    const manifest = JSON.parse(await readFile(packageUrl, 'utf8')) as { version?: unknown };
    if (typeof manifest.version === 'string' && manifest.version) return manifest.version;
  } catch (error) {
    throw new ProjectCliError(
      'CREATE_FAILED',
      `Could not read the installed Slidock version: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  runtimeError('The installed Slidock package has no version');
}

function scaffoldConfig(): string {
  return `import { defineConfig } from '@slidock/slidock';\n\nexport default defineConfig({\n  home: {\n    title: 'My Slides',\n    description: 'A collection of Slidev presentations.',\n  },\n});\n`;
}

function scaffoldDeck(title: string, heading: string, description: string): string {
  return `---\ntheme: '@slidev/theme-default'\ntitle: ${title}\nfonts:\n  sans: Arial\n  mono: monospace\n  webfonts: []\n---\n\n# ${heading}\n\n${description}\n`;
}

function scaffoldManifest(name: string, version: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'slidock dev',
        build: 'slidock build',
        preview: 'slidock preview',
      },
      devDependencies: { '@slidock/slidock': version },
    },
    null,
    2,
  )}\n`;
}

async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertParentsAreDirectories(root: string, relativeFile: string): Promise<void> {
  let current = root;
  const segments = dirname(relativeFile).split(/[\\/]/u).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    if (!(await existingPath(current))) continue;
    try {
      if (!(await lstat(current)).isDirectory())
        throw new ProjectCliError('FILE_EXISTS', `Cannot create scaffold inside ${current}`, 2);
    } catch (error) {
      if (error instanceof ProjectCliError) throw error;
      throw error;
    }
  }
}

async function createProject(directory: string): Promise<{
  root: string;
  files: string[];
  instructions: string[];
}> {
  const root = resolve(directory);
  const rootExists = await existingPath(root);
  if (rootExists && !(await lstat(root)).isDirectory())
    throw new ProjectCliError('FILE_EXISTS', `Target is not a directory: ${root}`, 2);

  const version = await frameworkVersion();
  const proposed = [
    { path: 'slidock.config.ts', contents: scaffoldConfig(), optional: false },
    {
      path: 'slides/welcome/slides.md',
      contents: scaffoldDeck('Welcome', 'Welcome to Slidock', 'Start editing this presentation.'),
      optional: false,
    },
    {
      path: 'slides/second/slides.md',
      contents: scaffoldDeck('Second deck', 'Your second deck', 'Add another presentation here.'),
      optional: false,
    },
    {
      path: 'package.json',
      contents: scaffoldManifest(safePackageName(root), version),
      optional: true,
    },
    { path: '.gitignore', contents: 'node_modules/\ndist/\n', optional: true },
  ];

  const writes: typeof proposed = [];
  for (const file of proposed) {
    await assertParentsAreDirectories(root, file.path);
    const target = join(root, file.path);
    if (await existingPath(target)) {
      if (file.optional) continue;
      throw new ProjectCliError('FILE_EXISTS', `Refusing to overwrite ${target}`, 2);
    }
    writes.push(file);
  }

  const created: string[] = [];
  try {
    await mkdir(root, { recursive: true });
    for (const file of writes) {
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, file.contents, { flag: 'wx', mode: 0o644 });
        created.push(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ProjectCliError('FILE_EXISTS', `Refusing to overwrite ${target}`, 2);
        throw error;
      }
    }
  } catch (error) {
    await Promise.all(created.map((file) => rm(join(root, file), { force: true }).catch(() => {})));
    throw error;
  }

  const instructions = writes.some((file) => file.path === 'package.json')
    ? ['npm install', 'npm run dev']
    : ['npx slidock dev', 'npx slidock build'];
  return { root, files: created, instructions };
}

async function runCreate(parsed: Parsed, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length > 1) inputError('slidock create accepts at most one directory');
  const directory = resolve(cwd, parsed.positionals[0] ?? '.');
  try {
    const result = await createProject(directory);
    const nextSteps = [
      ...(result.root === resolve(cwd)
        ? []
        : [`cd ${JSON.stringify(relativeDisplay(cwd, result.root))}`]),
      ...result.instructions,
    ];
    outputSuccess(
      'slidock create',
      result,
      json,
      `Created Slidock project at ${result.root}\nNext:\n${nextSteps.map((step) => `  ${step}`).join('\n')}`,
    );
  } catch (error) {
    if (error instanceof ProjectCliError) throw error;
    throw new ProjectCliError(
      'CREATE_FAILED',
      error instanceof Error ? error.message : String(error),
      1,
    );
  }
}

function relativeDisplay(cwd: string, target: string): string {
  return relative(resolve(cwd), resolve(target)) || '.';
}

async function waitForSignal(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((accept, reject) => {
    let done = false;
    const cleanup = () => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    const stop = (signal: NodeJS.Signals) => {
      if (done) return;
      done = true;
      cleanup();
      close()
        .then(accept, reject)
        .finally(() => {
          process.exitCode = signal === 'SIGINT' ? 130 : 143;
        });
    };
    const onInterrupt = () => stop('SIGINT');
    const onTerminate = () => stop('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
  });
}

function localUrl(address: string, port: number): string {
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

async function runDev(parsed: Parsed, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0)
    inputError('slidock dev does not accept positional arguments');
  const config = flagString(parsed.values, 'config');
  const port = portNumber(flagString(parsed.values, 'port'), 4174);
  if (flagString(parsed.values, 'host') !== undefined)
    inputError('slidock dev always binds to loopback');
  const project = await loadProject(optionLoad(cwd, config));
  const server = await devHub({
    ...project.options,
    port,
    resolveOptions: async () => (await loadProject(optionLoad(project.root, config))).options,
    watchFiles: [
      ...(project.configPath === undefined ? [] : [project.configPath]),
      project.homePagePath,
      dirname(project.homePagePath),
    ],
  });
  const result = {
    url: server.url,
    root: project.root,
    ...(project.configPath === undefined ? {} : { configPath: project.configPath }),
  };
  outputSuccess('slidock dev', result, json, `Slidock dev server ready at ${server.url}`);
  await waitForSignal(server.close);
}

async function runBuild(parsed: Parsed, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0)
    inputError('slidock build does not accept positional arguments');
  const project = await loadProject(optionLoad(cwd, flagString(parsed.values, 'config')));
  const result = await buildHub({
    ...project.options,
    onProgress: ({ phase }) => process.stderr.write(`slidock build: ${phase}\n`),
  });
  const output = {
    output: result.output,
    receiptPath: result.receiptPath,
    deckCount: result.receipt.decks.length,
    groups: buildGroups(result),
  };
  outputSuccess(
    'slidock build',
    output,
    json,
    `Built ${output.deckCount} decks to ${output.output}`,
  );
}

async function runCheck(parsed: Parsed, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0)
    inputError('slidock check does not accept positional arguments');
  const project = await loadProject(optionLoad(cwd, flagString(parsed.values, 'config')));
  const result = await checkProject(project);
  outputSuccess(
    'slidock check',
    result,
    json,
    `Project config is valid (${result.deckCount} decks)`,
  );
}

async function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<number> {
  await new Promise<void>((accept, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      accept();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    runtimeError('Preview server did not expose its address');
  return address.port;
}

async function runPreview(parsed: Parsed, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0)
    inputError('slidock preview does not accept positional arguments');
  const config = flagString(parsed.values, 'config');
  const port = portNumber(flagString(parsed.values, 'port'), 4174);
  const host = flagString(parsed.values, 'host') ?? '127.0.0.1';
  const project = await loadProject(optionLoad(cwd, config));
  const output = projectOutputPath(project);
  let server: ReturnType<typeof createServer>;
  let basePath: string;
  try {
    basePath = readSiteBasePath(output);
    server = createServer(output, { basePath });
  } catch (error) {
    throw new ProjectCliError(
      'PREVIEW_FAILED',
      `Could not open built site ${output}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  try {
    const actualPort = await listen(server, port, host);
    const result = {
      url: `${localUrl(host, actualPort).replace(/\/$/, '')}${basePath}`,
      output,
      root: project.root,
      ...(project.configPath === undefined ? {} : { configPath: project.configPath }),
    };
    outputSuccess('slidock preview', result, json, `Preview server ready at ${result.url}`);
    await waitForSignal(
      () =>
        new Promise<void>((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept())),
        ),
    );
  } catch (error) {
    if (server.listening) server.close();
    throw error;
  }
}

/** Run the consumer-facing local project CLI without depending on @slidock/cli. */
export async function runProjectCli(args: string[], cwd = process.cwd()): Promise<void> {
  const { command, rest } = cliCommand(args);
  const json = args.includes('--json');
  const label = command ? `slidock ${command}` : 'slidock';
  try {
    if (command === undefined) {
      try {
        parseArgs({
          args,
          options: {
            json: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean' },
          },
          strict: true,
          allowPositionals: false,
        });
      } catch {
        inputError('invalid slidock arguments');
      }
      const version = args.includes('--version');
      const result = version
        ? {
            version: JSON.parse(
              await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
            ).version,
          }
        : { help: usage() };
      outputSuccess('slidock', result, json, version ? String(result.version) : usage());
      return;
    }

    if (!commandNames.includes(command as Command))
      inputError(`unknown slidock command: ${command}`, 'UNKNOWN_COMMAND');
    const parsed = parseCommand(command, rest);
    if (parsed.values.version) {
      const manifest = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      outputSuccess(label, { version: manifest.version }, json, manifest.version);
      return;
    }
    if (parsed.values.help) {
      outputSuccess(label, { help: usage(command) }, json, usage(command));
      return;
    }

    if (command === 'create') {
      if (
        flagString(parsed.values, 'config') ||
        flagString(parsed.values, 'port') ||
        flagString(parsed.values, 'host')
      )
        inputError('slidock create accepts only a directory and --json');
      await runCreate(parsed, cwd, json);
    } else if (command === 'dev') {
      await runDev(parsed, cwd, json);
    } else if (command === 'build') {
      if (flagString(parsed.values, 'port') || flagString(parsed.values, 'host'))
        inputError('slidock build accepts only --config and --json');
      await runBuild(parsed, cwd, json);
    } else if (command === 'check') {
      if (flagString(parsed.values, 'port') || flagString(parsed.values, 'host'))
        inputError('slidock check accepts only --config and --json');
      await runCheck(parsed, cwd, json);
    } else {
      await runPreview(parsed, cwd, json);
    }
  } catch (error) {
    outputFailure(label, error, json);
  }
}
