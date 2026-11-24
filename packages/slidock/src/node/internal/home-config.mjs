export function injectSiteBase(html, basePath = '/') {
  if (!html.includes('</head>')) throw new Error('Generated HTML has no closing head element');
  const escaped = basePath
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
  return html.replace('</head>', `<meta name="slidock-base" content="${escaped}"></head>`);
}

export function injectHomeConfig(html, home) {
  if (home === undefined) return html;
  if (!html.includes('</head>')) throw new Error('Generated home HTML has no closing head element');
  const json = JSON.stringify(home).replace(/[<>&\u2028\u2029]/g, (character) => {
    const escaped = {
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029',
    };
    return escaped[character];
  });
  return html.replace(
    '</head>',
    `<script id="slidock-home-config" type="application/json">${json}</script></head>`,
  );
}
