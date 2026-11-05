/*
 * The sound catalog. This is the only file to edit when adding or replacing sounds.
 *
 * Put the audio file in sounds/ and add an entry:
 *
 *   id        stable and unique (later features such as favorites will key off it)
 *   name      the label on the key
 *   category  an id from `categories` below
 *   tags      extra words for search
 *   src       the file, relative to index.html
 *
 * The waveform, the time label and the pop-up speed all come from the audio itself.
 * A new category only needs a row in `categories`: its panel and filter chip appear
 * automatically.
 */
(function () {
  'use strict';

  const categories = [
    { id: 'internet', label: 'Internet Culture', color: '#ab8fff', side: '#6442c9' },
    { id: 'tv-movies', label: 'TV & Movies', color: '#ffc93c', side: '#bd8406' },
  ];

  const sounds = [
    { id: 'enrique', name: 'Enrique', category: 'internet', tags: 'meme',
      src: 'sounds/enrique.mp3' },
    { id: 'bruh', name: 'Bruh', category: 'internet', tags: 'meme reaction seriously',
      src: 'sounds/bruh.mp3' },
    { id: 'get-out', name: 'Get Out!', category: 'tv-movies', tags: 'tuco breaking bad yell quote',
      src: 'sounds/tuco-get-out.mp3' },
  ];

  window.SOUND_CATALOG = { categories, sounds };
})();
