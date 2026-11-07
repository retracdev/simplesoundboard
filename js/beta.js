/*
 * Beta access, read from beta.yml in the site's root. This site has no server of its own, so
 * the list decides what the page offers but can't stop someone determined from getting around
 * it in their own browser. Strings only ever touch that person's own cloud save.
 */
(function () {
  'use strict';

  const FILE = 'beta.yml';
  const CHECK_AGAIN_MS = 60000;

  let list = null;
  let readAt = 0;
  let inFlight = null;

  // Understands the one shape beta.yml uses: `feature: [name, name]`, with # comments.
  function parse(text) {
    const features = new Map();
    const source = String(text).replace(/#.*$/gm, '');
    const pattern = /^[ \t]*([\w-]+)[ \t]*:[ \t]*\[([^\]]*)\]/gm;
    let match;
    while ((match = pattern.exec(source))) {
      const names = match[2].split(',')
        .map((name) => name.trim().replace(/^["']|["']$/g, '').trim().toLowerCase())
        .filter(Boolean);
      features.set(match[1], new Set(names));
    }
    return features;
  }

  async function read() {
    if (list && Date.now() - readAt < CHECK_AGAIN_MS) return list;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          // Asks the server every time, so a new name doesn't wait on the browser's cache.
          const response = await fetch(FILE, { cache: 'no-cache' });
          if (!response.ok) throw new Error('Beta list unavailable');
          list = parse(await response.text());
          readAt = Date.now();
        } catch (error) {
          // Keeps the last good list. With none at all, nobody has access until it can be read.
          console.warn('Could not read ' + FILE, error);
        } finally {
          inFlight = null;
        }
        return list;
      })();
    }
    return inFlight;
  }

  window.SoundBeta = {
    parse,
    async hasAccess(feature, username) {
      const features = await read();
      const names = features && features.get(feature);
      return Boolean(names && username && (names.has('*') || names.has(username.toLowerCase())));
    },
  };
})();
