/** Colour themes. Each one just sets the CSS variables the whole app is built from. */
const mk = (id, name, o) => ({
  id, name,
  v: {
    '--bg': o.bg, '--bg2': o.bg2, '--bg3': o.bg3, '--line': o.line, '--text': o.text, '--muted': o.muted,
    '--brand': o.brand, '--brand2': o.brand2,
    '--grad': `linear-gradient(135deg, ${o.brand}, ${o.brand2})`,
    '--brand-rgb': o.brandRgb, '--brand2-rgb': o.brand2Rgb,
    '--bubble': `linear-gradient(135deg, ${o.brand}, ${o.bubbleEnd || o.brand})`,
    '--photo': o.photo || '#ff4d6d', '--video': o.video || '#a855f7', '--ok': o.ok || '#3ddc97',
    '--on-brand': o.on || '#fff', '--card': o.card, '--toast': o.toast,
  },
  scheme: o.light ? 'light' : 'dark',
  preview: [o.bg, o.bg3, o.brand, o.brand2],
});

export const THEMES = [
  mk('midnight', 'Midnight', {
    bg: '#0b0b10', bg2: '#14141c', bg3: '#1e1e29', line: '#2b2b3a', text: '#f5f5fa', muted: '#9a9ab2',
    brand: '#7c5cff', brand2: '#ff4f9a', brandRgb: '124, 92, 255', brand2Rgb: '255, 79, 154', bubbleEnd: '#9a5cff',
    card: 'rgba(20, 20, 28, .72)', toast: 'rgba(35, 35, 48, .96)',
  }),
  mk('ocean', 'Ocean', {
    bg: '#06121c', bg2: '#0c1d2b', bg3: '#13293b', line: '#1f3a50', text: '#eaf6ff', muted: '#86a6bd',
    brand: '#1fa3ff', brand2: '#2de2c4', brandRgb: '31, 163, 255', brand2Rgb: '45, 226, 196', bubbleEnd: '#1f7ae0',
    photo: '#ff6b8a', video: '#7a8cff', card: 'rgba(12, 29, 43, .75)', toast: 'rgba(19, 41, 59, .96)', on: '#031422',
  }),
  mk('sunset', 'Sunset', {
    bg: '#140a0c', bg2: '#1f1114', bg3: '#2c1a1d', line: '#432a2c', text: '#fff3ee', muted: '#c49c94',
    brand: '#ff7a3d', brand2: '#ff3d77', brandRgb: '255, 122, 61', brand2Rgb: '255, 61, 119', bubbleEnd: '#ff4f5e',
    photo: '#ff3d77', video: '#c04dff', card: 'rgba(31, 17, 20, .75)', toast: 'rgba(44, 26, 29, .96)',
  }),
  mk('forest', 'Forest', {
    bg: '#08140e', bg2: '#0f1f16', bg3: '#17301f', line: '#244632', text: '#eaf7ee', muted: '#8fb29b',
    brand: '#2fcf74', brand2: '#b6e83a', brandRgb: '47, 207, 116', brand2Rgb: '182, 232, 58', bubbleEnd: '#1fae5e',
    photo: '#ff6b6b', video: '#9b7bff', card: 'rgba(15, 31, 22, .75)', toast: 'rgba(23, 48, 31, .96)', on: '#03180b',
  }),
  mk('bubblegum', 'Bubblegum', {
    bg: '#1a0f1e', bg2: '#25162b', bg3: '#321f3a', line: '#4a2f55', text: '#fff0fb', muted: '#c9a1c9',
    brand: '#ff5fc8', brand2: '#8a7bff', brandRgb: '255, 95, 200', brand2Rgb: '138, 123, 255', bubbleEnd: '#e24bb0',
    photo: '#ff4f7a', video: '#8a7bff', card: 'rgba(37, 22, 43, .75)', toast: 'rgba(50, 31, 58, .96)', on: '#2a0620',
  }),
  mk('daylight', 'Daylight', {
    bg: '#f6f6fb', bg2: '#ffffff', bg3: '#ebebf4', line: '#dcdce9', text: '#15151f', muted: '#6c6c85',
    brand: '#6a4cff', brand2: '#ff4f9a', brandRgb: '106, 76, 255', brand2Rgb: '255, 79, 154', bubbleEnd: '#8a4cff',
    ok: '#12a56a', card: 'rgba(255, 255, 255, .85)', toast: 'rgba(255, 255, 255, .97)', light: true,
  }),
  mk('neon', 'Neon', {
    bg: '#000000', bg2: '#0a0a0a', bg3: '#161616', line: '#2a2a2a', text: '#ffffff', muted: '#8c8c8c',
    brand: '#d4ff3a', brand2: '#00e5ff', brandRgb: '212, 255, 58', brand2Rgb: '0, 229, 255', bubbleEnd: '#a6e600',
    photo: '#ff2d6f', video: '#b26bff', card: 'rgba(10, 10, 10, .8)', toast: 'rgba(22, 22, 22, .97)', on: '#0a0a0a',
  }),
  mk('mint', 'Mint', {
    bg: '#f1faf6', bg2: '#ffffff', bg3: '#e2f3ea', line: '#cfe6da', text: '#0f241a', muted: '#5d7f6d',
    brand: '#0fa968', brand2: '#14b8c4', brandRgb: '15, 169, 104', brand2Rgb: '20, 184, 196', bubbleEnd: '#0a8f58',
    ok: '#0a8f58', card: 'rgba(255, 255, 255, .85)', toast: 'rgba(255, 255, 255, .97)', light: true,
  }),
  mk('blossom', 'Blossom', {
    bg: '#fff5f8', bg2: '#ffffff', bg3: '#fde6ee', line: '#f5cfdc', text: '#2b0f1a', muted: '#8d5f70',
    brand: '#e0457b', brand2: '#ff8a5c', brandRgb: '224, 69, 123', brand2Rgb: '255, 138, 92', bubbleEnd: '#c93a6d',
    ok: '#12a56a', card: 'rgba(255, 255, 255, .85)', toast: 'rgba(255, 255, 255, .97)', light: true,
  }),
  mk('sky', 'Sky', {
    bg: '#f0f7ff', bg2: '#ffffff', bg3: '#e1eefc', line: '#cadcf3', text: '#0d1b2e', muted: '#5a7391',
    brand: '#1e78e6', brand2: '#7a5cff', brandRgb: '30, 120, 230', brand2Rgb: '122, 92, 255', bubbleEnd: '#1a62c4',
    ok: '#12a56a', card: 'rgba(255, 255, 255, .85)', toast: 'rgba(255, 255, 255, .97)', light: true,
  }),
  mk('lava', 'Lava', {
    bg: '#130808', bg2: '#1e0d0d', bg3: '#2d1414', line: '#471f1f', text: '#fff1f0', muted: '#c79491',
    brand: '#ff3b30', brand2: '#ff9500', brandRgb: '255, 59, 48', brand2Rgb: '255, 149, 0', bubbleEnd: '#d92b22',
    photo: '#ff9500', video: '#af52de', card: 'rgba(30, 13, 13, .75)', toast: 'rgba(45, 20, 20, .96)',
  }),
  mk('gold', 'Gold', {
    bg: '#12100a', bg2: '#1c1910', bg3: '#2a2517', line: '#403821', text: '#fff8e1', muted: '#c4b68a',
    brand: '#ffc400', brand2: '#ff8f00', brandRgb: '255, 196, 0', brand2Rgb: '255, 143, 0', bubbleEnd: '#e6a800',
    photo: '#ff6b3d', video: '#b26bff', card: 'rgba(28, 25, 16, .75)', toast: 'rgba(42, 37, 23, .96)', on: '#1a1200',
  }),
  mk('slate', 'Slate', {
    bg: '#0f1419', bg2: '#171e26', bg3: '#212a35', line: '#303c4a', text: '#e8eef5', muted: '#8ea0b3',
    brand: '#5b8def', brand2: '#8bd0ff', brandRgb: '91, 141, 239', brand2Rgb: '139, 208, 255', bubbleEnd: '#3f6fd1',
    card: 'rgba(23, 30, 38, .75)', toast: 'rgba(33, 42, 53, .96)',
  }),
  mk('mocha', 'Mocha', {
    bg: '#15100d', bg2: '#201814', bg3: '#2e231d', line: '#463529', text: '#f6ece4', muted: '#b79c88',
    brand: '#d08a5a', brand2: '#f0c987', brandRgb: '208, 138, 90', brand2Rgb: '240, 201, 135', bubbleEnd: '#b86f40',
    photo: '#e8665a', video: '#9b7bff', card: 'rgba(32, 24, 20, .75)', toast: 'rgba(46, 35, 29, .96)', on: '#1c0f06',
  }),
  mk('aurora', 'Aurora', {
    bg: '#070d16', bg2: '#0e1826', bg3: '#16263a', line: '#243a55', text: '#e9fbff', muted: '#84a4b8',
    brand: '#3de0c0', brand2: '#9b6bff', brandRgb: '61, 224, 192', brand2Rgb: '155, 107, 255', bubbleEnd: '#1fb89c',
    photo: '#ff6b8a', video: '#9b6bff', card: 'rgba(14, 24, 38, .75)', toast: 'rgba(22, 38, 58, .96)', on: '#03170f',
  }),
];

const KEY = 'blink_theme';
export const themeById = id => THEMES.find(t => t.id === id) || THEMES[0];

export function loadTheme() {
  try { return themeById(localStorage.getItem(KEY)).id; } catch { return THEMES[0].id; }
}

/** Apply a theme to the whole page (and remember it on this device). */
export function applyTheme(id, save = true) {
  const t = themeById(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.v)) root.style.setProperty(k, v);
  root.style.setProperty('color-scheme', t.scheme);
  root.dataset.theme = t.id;
  for (const name of ['theme-color']) {
    const m = document.querySelector(`meta[name=${name}]`);
    if (m) m.setAttribute('content', t.v['--bg']);
  }
  const cs = document.querySelector('meta[name=color-scheme]');
  if (cs) cs.setAttribute('content', t.scheme);
  if (save) { try { localStorage.setItem(KEY, t.id); } catch { /* ignore */ } }
  return t.id;
}
