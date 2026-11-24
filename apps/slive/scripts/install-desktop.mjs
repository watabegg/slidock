import { copyFile, mkdir, access, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('This launcher installer is for Linux.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(root, 'target/debug/slive');
const config = resolve(process.argv[2] ?? join(root, 'artifacts/local-config.json'));
await Promise.all([access(binary), access(config)]);
const configuredDataHome = process.env.XDG_DATA_HOME;
const data =
  configuredDataHome && isAbsolute(configuredDataHome)
    ? configuredDataHome
    : join(homedir(), '.local/share');
const applications = join(data, 'applications');
const icons = join(data, 'icons/hicolor/512x512/apps');
await Promise.all([mkdir(applications, { recursive: true }), mkdir(icons, { recursive: true })]);
await copyFile(join(root, 'src-tauri/icons/icon.png'), join(icons, 'local.slidev.lab.png'));
const quote = (value) => {
  if (/[\r\n]/.test(value)) throw new Error('Launcher paths must not contain newlines.');
  return '"' + value.replace(/([\\`"$])/g, '\\$1').replaceAll('%', '%%') + '"';
};
const entry = [
  '[Desktop Entry]',
  'Type=Application',
  'Name=Slive',
  'Comment=Present Slidev slides',
  'Exec=' + quote(binary) + ' --config ' + quote(config),
  'Icon=local.slidev.lab',
  'Terminal=false',
  'Categories=Office;Presentation;',
  'StartupWMClass=Slive',
  'StartupNotify=true',
  '',
].join('\n');
const destination = join(applications, 'local.slidev.lab.desktop');
await writeFile(destination, entry);
try {
  execFileSync('update-desktop-database', [applications], { stdio: 'ignore' });
} catch {
  // Desktop environments can also discover entries without this optional cache.
}
console.log(destination);
