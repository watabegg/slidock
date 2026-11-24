import { devHub } from '@slidock/slidock';
import { officialThemesConfig } from './official-themes-config.mjs';

const starting = officialThemesConfig({ verifySources: false }).then((config) => devHub(config));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    stopping = true;
    await starting.then((server) => server.close()).catch(() => {});
  });
try {
  const server = await starting;
  if (!stopping) console.log(`Slidock: ${server.url} (hot reload)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
