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
    { id: 'games', label: 'Games', color: '#93e571', side: '#479c2c' },
    { id: 'hits', label: 'Hits & Impacts', color: '#ff8360', side: '#bf4526' },
    { id: 'sad', label: 'Sad & Dramatic', color: '#6fb1ff', side: '#2f6fc2' },
    { id: 'silly', label: 'Silly', color: '#ff7eb6', side: '#c0407b' },
    { id: 'tech', label: 'Tech', color: '#35d6c8', side: '#12877c' },
  ];

  const sounds = [
    { id: 'enrique', name: 'Enrique', category: 'internet', tags: 'meme',
      src: 'sounds/enrique.mp3' },
    { id: 'bruh', name: 'Bruh', category: 'internet', tags: 'meme reaction seriously',
      src: 'sounds/bruh.mp3' },
    { id: 'fahh', name: 'Fahh', category: 'internet', tags: 'meme fah fahhh reaction',
      src: 'sounds/fahh.mp3' },
    { id: 'vine-boom', name: 'Boom (Vine)', category: 'internet', tags: 'meme impact bass dramatic',
      src: 'sounds/vine-boom.mp3' },
    { id: 'wow', name: 'WOW!', category: 'internet', tags: 'meme anime reaction surprised',
      src: 'sounds/anime-wow.mp3' },
    { id: 'rizz', name: 'Rizz', category: 'internet', tags: 'meme flirt charm smooth',
      src: 'sounds/rizz.mp3' },
    { id: 'shocked', name: 'Shocked', category: 'internet', tags: 'meme reaction surprised',
      src: 'sounds/shocked.mp3' },
    { id: 'sus', name: 'Sus (aka Dexter meme)', category: 'internet', tags: 'suspicious sussy tv show',
      src: 'sounds/dexter-meme.mp3' },
    { id: 'taco-bell', name: 'Taco Bell', category: 'internet', tags: 'bong meme fast food',
      src: 'sounds/taco-bell-bong.mp3' },
    { id: 'social-credit-siren', name: 'Siren (aka -999 Social Credit)', category: 'internet', tags: 'alarm meme minus',
      src: 'sounds/social-credit-siren.mp3' },
    { id: 'oh-my-god', name: 'Oh my god!', category: 'internet', tags: 'omg meme reaction surprised',
      src: 'sounds/oh-my-god.mp3' },
    { id: 'i-got-this', name: 'I got this!', category: 'internet', tags: 'meme confident',
      src: 'sounds/i-got-this.mp3' },
    { id: 'get-out', name: 'Get Out!', category: 'tv-movies', tags: 'tuco breaking bad yell quote',
      src: 'sounds/tuco-get-out.mp3' },
    { id: 'spongebob-failure', name: 'SpongeBob Failure', category: 'tv-movies', tags: 'fail cartoon sad lose',
      src: 'sounds/spongebob-fail.mp3' },
    { id: 'a-few-moments-later', name: 'A Few Moments Later', category: 'tv-movies', tags: 'spongebob narrator time card',
      src: 'sounds/a-few-moments-later.mp3' },
    { id: 'shut-up-mom', name: 'Shut Up Mom!', category: 'tv-movies', tags: 'key peele sketch comedy brother',
      src: 'sounds/shut-up-mom.mp3' },
    { id: 'among-us-role-reveal', name: 'Among Us Role Reveal', category: 'games', tags: 'impostor imposter crewmate sus',
      src: 'sounds/among-us-role-reveal.mp3' },
    { id: 'knocked', name: 'Knocked (from Fortnite)', category: 'games', tags: 'battle royale down eliminated death',
      src: 'sounds/fortnite-knocked.mp3' },
    { id: 'bone-crack', name: 'Bone Crack', category: 'hits', tags: 'break snap ouch hurt',
      src: 'sounds/bone-crack.mp3' },
    { id: 'metal-pipe-clang', name: 'Metal Pipe Clang', category: 'hits', tags: 'meme falling steel',
      src: 'sounds/metal-pipe-clang.mp3' },
    { id: 'punch', name: 'Punch', category: 'hits', tags: 'hit fight gaming',
      src: 'sounds/punch.mp3' },
    { id: 'sad-bell', name: 'Sad Bell (aka Undertakers Bell)', category: 'sad', tags: 'undertaker wrestling funeral gong toll',
      src: 'sounds/undertakers-bell.mp3' },
    { id: 'sad-violin', name: 'Sad Violin', category: 'sad', tags: 'sorrow tiny strings music',
      src: 'sounds/sad-violin.mp3' },
    { id: 'fart-1', name: 'Fart (1)', category: 'silly', tags: 'dry toot gas funny',
      src: 'sounds/dry-fart.mp3' },
    { id: 'fart-2', name: 'Fart (2)', category: 'silly', tags: 'perfect toot gas funny',
      src: 'sounds/perfect-fart.mp3' },
    { id: 'apple-pay', name: 'Apple Pay', category: 'tech', tags: 'payment iphone phone checkout tap',
      src: 'sounds/apple-pay.mp3' },
    { id: 'samsung-notification', name: 'Samsung Notification', category: 'tech', tags: 'phone galaxy android alert spaceline',
      src: 'sounds/samsung-notification.mp3' },
    { id: 'samsung-notification-boosted', name: 'Samsung Notification (Boosted)', category: 'tech', tags: 'phone galaxy android alert bass loud meme',
      src: 'sounds/samsung-notification-boosted.mp3' },
  ];

  window.SOUND_CATALOG = { categories, sounds };
})();
