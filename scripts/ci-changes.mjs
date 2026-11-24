import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const suites = ['portable', 'framework', 'server', 'native'];
const all = () => Object.fromEntries(suites.map((suite) => [suite, true]));

export function selectSuites(paths) {
  const selected = Object.fromEntries(suites.map((suite) => [suite, false]));
  for (const path of paths) {
    let affected;
    if (path.startsWith('docs/') || ['AGENTS.md', 'TODO.md'].includes(path)) {
      continue;
    } else if (/^packages\/(protocol|slidev-adapter|slidock)\//.test(path)) {
      // All suites consume these packages, directly or through CLI/runtime builds.
      return all();
    } else if (
      /^packages\/(cli|slive-tools|server|adapter-cloudflare)\//.test(path) ||
      path.startsWith('apps/slidock-worker/')
    ) {
      // Worker browser/native checks and Node publication checks share these inputs.
      affected = ['portable', 'server', 'native'];
    } else if (
      /^packages\/(adapter-node|storage-s3|storage-gcs|state-postgres|renderer-playwright)\//.test(
        path,
      ) ||
      path.startsWith('apps/slidock-server/')
    ) {
      affected = ['server'];
    } else if (path.startsWith('apps/slive/')) {
      affected = ['portable', 'native'];
    } else if (path.startsWith('examples/')) {
      // Static demos, custom frontend and local native fixtures share example inputs.
      affected = ['portable', 'framework', 'native'];
    } else {
      // Includes workflows, root manifests/lockfile, scripts and new unclassified inputs.
      return all();
    }
    for (const suite of affected) selected[suite] = true;
  }
  return selected;
}

export function changedPaths(eventName, event, git = (...args) => execFileSync('git', args)) {
  let base;
  let head;
  if (eventName === 'push') {
    base = event.before;
    head = event.after;
  } else if (eventName === 'pull_request') {
    base = event.pull_request?.base.sha;
    head = event.pull_request?.head.sha;
  } else {
    throw new Error('Manual or unrecognized event: run all suites');
  }
  for (const sha of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(sha ?? '') || /^0+$/.test(sha)) {
      throw new Error('Missing comparison commit: run all suites');
    }
  }
  if (eventName === 'pull_request') {
    base = git('merge-base', base, head).toString().trim();
  }
  // --no-renames includes both old and new paths, so moving out cannot skip a suite.
  return git('diff', '--name-only', '--no-renames', '-z', base, head, '--')
    .toString()
    .split('\0')
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let selected;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    selected = selectSuites(changedPaths(process.env.GITHUB_EVENT_NAME, event));
  } catch (error) {
    console.warn(`Running all suites: ${error.message}`);
    selected = all();
  }
  const output = Object.entries(selected)
    .map(([suite, enabled]) => `${suite}=${enabled}\n`)
    .join('');
  console.log(output.trim());
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
