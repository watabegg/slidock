import { buildHub } from '@slidock/slidock';
import { officialThemesConfig } from './official-themes-config.mjs';

const result = await buildHub({
  ...(await officialThemesConfig()),
  onProgress: ({ phase }) => console.log(`Slidock: ${phase}`),
});
console.log(result.output);
