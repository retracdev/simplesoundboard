(function () {
  'use strict';

  const rows = document.getElementById('lookupRows');
  const status = document.getElementById('lookupStatus');
  const refresh = document.getElementById('refreshLookups');
  const { sounds, categories } = window.SOUND_CATALOG;
  const categoryNames = new Map(categories.map((category) => [category.id, category.label]));
  const creditedSounds = sounds.filter((sound) => sound.requestedBy);

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function lookup(userId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        `https://space-api.retrac-space.workers.dev/v1/players/id/${encodeURIComponent(userId)}`,
        { credentials: 'omit', signal: controller.signal }
      );
      const raw = await response.text();
      let data;
      let body = raw;
      try {
        data = JSON.parse(raw);
        body = JSON.stringify(data, null, 2);
      } catch { /* Keep non-JSON responses visible for diagnosis. */ }
      const username = typeof data?.data?.username === 'string' ? data.data.username.trim() : '';
      const ok = response.ok && Boolean(username);
      return {
        ok,
        username: ok ? username : 'Unavailable',
        message: `HTTP ${response.status}` + (response.ok && !username ? ' — No username returned' : ''),
        body: body || '(Empty response)',
      };
    } catch (error) {
      return {
        ok: false,
        username: 'Unavailable',
        message: error.name === 'AbortError' ? 'Timed out after 10 seconds' : 'Network request failed',
        body: error.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function load() {
    refresh.disabled = true;
    rows.replaceChildren();
    // Reuse each user's response across cards; refresh starts fresh lookups.
    const targetsByUser = new Map();
    creditedSounds.forEach((sound) => {
      const ids = Array.isArray(sound.requestedBy) ? sound.requestedBy : [sound.requestedBy];
      ids.forEach((userId) => {
        const row = element('tr');
        const soundCell = element('td');
        soundCell.append(element('strong', sound.name), element('small', categoryNames.get(sound.category)));
        const idCell = element('td');
        idCell.appendChild(element('code', userId));
        const username = element('td', 'Loading…');
        const result = element('td', 'Waiting for response…');
        row.append(soundCell, idCell, username, result);
        rows.appendChild(row);
        if (!targetsByUser.has(userId)) targetsByUser.set(userId, []);
        targetsByUser.get(userId).push({ username, result });
      });
    });

    let completed = 0;
    let failed = 0;
    function updateStatus() {
      status.textContent = `${creditedSounds.length} sounds · ${completed}/${targetsByUser.size} requester lookups complete · ${failed} failed`;
    }
    updateStatus();
    try {
      await Promise.all(Array.from(targetsByUser, async ([userId, targets]) => {
        const answer = await lookup(userId);
        targets.forEach(({ username, result }) => {
          username.textContent = answer.username;
          result.replaceChildren(element('span', answer.message));
          result.dataset.state = answer.ok ? 'success' : 'error';
          const details = element('details');
          details.append(element('summary', 'View response'), element('pre', answer.body));
          result.appendChild(details);
        });
        completed++;
        if (!answer.ok) failed++;
        updateStatus();
      }));
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  load();
})();
