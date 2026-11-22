// Shared body parts for the voxel figurines.
// Layout (z): plinth 0..7, legs 8..11, torso 12..22, head 23..34, hair from 35.
// Torso: x -5..4, y -3..2 (front plane y = 2, overlays on y = 3). Head: x -7..6, y -6..4 (face plane y = 4, overlays on y = 5).
import { mix, dark, lite } from './voxelKit.mjs';

export const INK = '#1E1F29';
export const CHAR = '#2B3144';

const FONT = {
  A: ['111', '101', '111', '101', '101'], G: ['111', '100', '101', '101', '111'], L: ['100', '100', '100', '100', '111'],
  Z: ['111', '001', '010', '100', '111'], M: ['10001', '11011', '10101', '10001', '10001'], Q: ['0110', '1001', '1001', '1010', '0101'],
  X: ['101', '101', '010', '101', '101'], R: ['110', '101', '110', '101', '101'],
};

// plinth with the 4-letter code set into its front; top(x, y) may return a colour for the top surface
export function plinth(v, f, code, top) {
  const block = mix(f.deep, f.dark, 0.3);
  v.box(-11, 10, -11, 10, 0, 0, dark(f.deep, 0.3));
  v.box(-10, 9, -10, 9, 1, 7, block);
  for (let x = -10; x <= 9; x++) for (let y = -10; y <= 9; y++) {
    const edge = x === -10 || x === 9 || y === -10 || y === 9;
    v.get(x, y, 7).t = edge ? mix(f.dark, f.light, 0.45) : (top && top(x, y)) || f.dark;
  }
  const glyphs = [...code].map((ch) => FONT[ch]);
  const width = glyphs.reduce((n, g) => n + g[0].length, 0) + glyphs.length - 1;
  let x = -10 + Math.round((20 - width) / 2);
  for (const g of glyphs) {
    for (let r = 0; r < 5; r++) for (let c = 0; c < g[0].length; c++) if (g[r][c] === '1') v.get(x + c, 9, 6 - r).l = f.light;
    x += g[0].length + 1;
  }
}

export function head(v, sk) {
  v.box(-7, 6, -6, 4, 23, 34, sk.base, { ao: 0.4, r: mix(sk.base, sk.shade, 0.8) });
  for (const [x, y] of [[-7, -6], [6, -6], [-7, 4], [6, 4]]) for (let z = 23; z <= 34; z++) v.set(x, y, z, null);
  for (let x = -7; x <= 6; x++) for (const y of [-6, 4]) { v.set(x, y, 23, null); v.set(x, y, 34, null); }
  for (let y = -6; y <= 4; y++) for (const x of [-7, 6]) { v.set(x, y, 23, null); v.set(x, y, 34, null); }
  for (const x of [-8, 7]) v.box(x, x, -2, -1, 26, 29, sk.shade);
}

// Face features are painted on the y = 4 plane; glasses and the nose stick out one cube.
export function face(v, sk, o = {}) {
  const { eyes = 'open', brows = 'flat', mouth = 'smile', blush = true, browC = '#3A2C28', glasses, beard, beardC = '#2A2A33', lash } = o;
  const skinO = { ao: 0.4 };
  const F = (x, z, c) => v.set(x, 4, z, c, skinO);
  if (beard === 'full' || beard === 'trim') {
    const zt = beard === 'full' ? 26 : 25;
    for (let x = -6; x <= 5; x++) for (let z = 24; z <= zt; z++) F(x, z, beardC);
    for (const x of [-7, 6]) for (let y = -2; y <= 3; y++) for (let z = 24; z <= zt + 2; z++) if (v.get(x, y, z)) v.set(x, y, z, beardC);
  } else if (beard === 'stubble') {
    const c = mix(sk.base, beardC, 0.28);
    for (let x = -6; x <= 5; x++) for (let z = 24; z <= 26; z++) if ((x + z) % 2 === 0) F(x, z, c);
  }
  if (blush && beard !== 'full') for (const x of [-5, -4, 3, 4]) F(x, 26, mix(sk.base, '#F0705E', 0.36));
  const eye = (x0, t, side) => {
    const out = side < 0 ? x0 - 1 : x0 + 2, inn = side < 0 ? x0 + 2 : x0 - 1;
    if (t === 'open') { for (const z of [28, 29]) { F(x0, z, INK); F(x0 + 1, z, INK); } F(x0, 29, '#FFFFFF'); }
    else if (t === 'wide') { for (const z of [28, 29, 30]) { F(x0, z, INK); F(x0 + 1, z, INK); } F(x0, 30, '#FFFFFF'); }
    else if (t === 'calm') { F(x0 - 1, 29, INK); F(x0, 28, INK); F(x0 + 1, 28, INK); F(x0 + 2, 29, INK); }
    else if (t === 'happy') { F(x0 - 1, 28, INK); F(x0, 29, INK); F(x0 + 1, 29, INK); F(x0 + 2, 28, INK); }
    else if (t === 'shut') { F(x0, 28, INK); F(x0 + 1, 28, INK); }
    else if (t === 'line') { F(x0, 28, INK); F(x0 + 1, 28, INK); F(out, 28, INK); F(out, 29, INK); }
    if (lash && (t === 'open' || t === 'wide')) F(out, 29, INK);
    return inn;
  };
  const [el, er] = Array.isArray(eyes) ? eyes : [eyes, eyes];
  if (el) eye(-4, el, -1);
  if (er) eye(2, er, 1);
  const BR = { flat: [31, 31, 31], up: [32, 32, 32], angry: [32, 31, 31], worried: [31, 31, 32], high: [33, 33, 32] };
  const [bl, br] = Array.isArray(brows) ? brows : [brows, brows];
  if (bl) BR[bl].forEach((z, i) => F(-5 + i, z, browC));
  if (br) BR[br].forEach((z, i) => F(4 - i, z, browC));
  const nose = mix(sk.base, sk.shade, 0.5);
  v.set(-1, 5, 27, nose, skinO); v.set(0, 5, 27, nose, skinO);
  const lip = mix(sk.lip, sk.base, 0.12);
  if (mouth === 'smile') { for (let x = -2; x <= 1; x++) F(x, 25, lip); F(-3, 26, lip); F(2, 26, lip); }
  else if (mouth === 'flat') for (let x = -2; x <= 1; x++) F(x, 25, lip);
  else if (mouth === 'grin') { for (let x = -3; x <= 2; x++) F(x, 25, '#FFFFFF'); F(-4, 26, lip); F(3, 26, lip); for (let x = -2; x <= 1; x++) F(x, 24, dark(lip, 0.15)); F(-3, 24, lip); F(2, 24, lip); }
  else if (mouth === 'smirk') { for (let x = -2; x <= 1; x++) F(x, 25, lip); F(2, 26, lip); }
  else if (mouth === 'small') { F(-1, 25, lip); F(0, 25, lip); }
  else if (mouth === 'frown') { for (let x = -2; x <= 1; x++) F(x, 25, lip); F(-3, 24, lip); F(2, 24, lip); }
  if (glasses) {
    const gc = glasses.c || '#1D2A66';
    // frames lie flat on the face so the eyes stay visible from above
    for (const x0 of [-4, 2]) {
      for (const dx of [0, 1]) { F(x0 + dx, 30, gc); F(x0 + dx, 27, gc); }
      for (const z of [28, 29]) { F(x0 - 1, z, gc); F(x0 + 2, z, gc); }
    }
    F(-1, 29, gc); F(0, 29, gc); F(5, 29, gc); F(-6, 29, gc);
    v.set(6, 4, 29, gc); v.set(-7, 4, 29, gc);
    for (let y = 3; y >= -1; y--) { v.set(7, y, 29, gc); v.set(-8, y, 29, gc); }
  }
}

// Hair shell. layers: [inset, frontY] per layer above the skull; sideY: how far forward the side hair reaches;
// sideZ / backZ: how low it hangs; fringe(x): rows of fringe over the forehead at column x.
export function hairShell(v, h, o = {}) {
  const { layers = [[0, 4]], sideY = 0, sideZ = 30, backZ = 26, fringe = () => 0, stripe = 4, locks = false } = o;
  const c2 = mix(h.base, h.shade, 0.32);
  const col = (x) => (stripe && (x + 98) % stripe === 0 ? c2 : h.base);
  layers.forEach(([inset, yf], k) => v.box(-8 + inset, 7 - inset, -7 + inset, yf, 35 + k, 35 + k, col));
  for (let x = -6; x <= 5; x++) { v.set(x, 4, 34, col(x)); v.set(x, -6, 34, col(x)); }
  for (let y = -5; y <= 3; y++) { v.set(-7, y, 34, h.base); v.set(6, y, 34, h.base); }
  for (const x of [-8, 7]) v.box(x, x, -7, sideY, sideZ, 34, (xx, y, z) => ((z + 99) % 3 === 0 ? c2 : h.base));
  v.box(-8, 7, -7, -7, backZ, 34, h.base);
  for (let z = backZ; z <= 34 + layers.length; z++) { v.set(-8, -7, z, null); v.set(7, -7, z, null); }
  for (let x = -6; x <= 5; x++) { const n = fringe(x); for (let i = 0; i < n; i++) v.set(x, 5, 34 - i, col(x)); if (n) v.set(x, 5, 35, col(x)); }
  if (locks) for (const x of [-7, 6]) v.box(x, x, 4, 4, locks, 34, h.base);
}

export function body(v, o) {
  const { main, legs = CHAR, shoe = '#14161F', sole, belt } = o;
  v.box(-5, -2, -3, 1, 9, 11, legs); v.box(1, 4, -3, 1, 9, 11, legs);
  v.box(-5, -2, -3, 3, 8, 8, shoe, sole ? { l: sole, r: dark(sole, 0.25) } : undefined);
  v.box(1, 4, -3, 3, 8, 8, shoe, sole ? { l: sole, r: dark(sole, 0.25) } : undefined);
  v.box(-5, 4, -3, 2, 12, 22, main);
  if (belt) v.box(-5, 4, -3, 2, 12, 12, belt);
}

// V opening at the neck showing an inner layer; halves = half-width per row from the top row down
export function vneck(v, inner, halves, lapel) {
  halves.forEach((hw, i) => {
    const z = 22 - i;
    for (let x = -hw; x <= hw - 1; x++) v.set(x, 2, z, inner);
    if (lapel) { v.set(-hw - 1, 3, z, lapel); v.set(hw, 3, z, lapel); if (i < 2) { v.set(-hw - 2, 3, z, lapel); v.set(hw + 1, 3, z, lapel); } }
  });
}

// Arm poses. side -1 = the figure's right arm (screen left), +1 = left arm (screen right). bare: forearm shows skin.
export function arm(v, side, pose, o) {
  const { sleeve, skin, cuff, bare } = o;
  const xs = side < 0 ? [-7, -6] : [5, 6];
  const sk = skin.base;
  const low = bare ? sk : sleeve;
  if (pose === 'down') {
    v.box(xs[0], xs[1], -2, 1, 19, 22, sleeve); v.box(xs[0], xs[1], -2, 1, 15, 18, low);
    if (cuff) v.box(xs[0], xs[1], -2, 1, bare ? 19 : 15, bare ? 19 : 15, cuff);
    v.box(xs[0], xs[1], -1, 1, 13, 14, sk);
    return { x: xs[0], y: 0, z: 13 };
  }
  if (pose === 'fwd') {
    v.box(xs[0], xs[1], -2, 1, 18, 22, sleeve); v.box(xs[0], xs[1], 2, 5, 18, 19, low);
    if (cuff) v.box(xs[0], xs[1], 5, 5, 18, 19, cuff);
    v.box(xs[0], xs[1], 6, 7, 18, 19, sk);
    return { x: xs[0], y: 7, z: 19 };
  }
  if (pose === 'in') {
    v.box(xs[0], xs[1], -2, 1, 17, 22, sleeve); v.box(xs[0], xs[1], 2, 4, 17, 18, low);
    const hx = side < 0 ? [-4, -3] : [2, 3];
    v.box(Math.min(hx[0], xs[0]), Math.max(hx[1], xs[1]), 4, 5, 17, 18, low);
    if (cuff) v.box(hx[0], hx[1], 5, 5, 17, 18, cuff);
    v.box(hx[0], hx[1], 6, 7, 17, 18, sk);
    return { x: hx[0], y: 7, z: 18 };
  }
  if (pose === 'up') { // raised beside the head; use on side +1
    v.box(5, 6, -3, 0, 20, 22, sleeve); v.box(7, 9, -3, -1, 21, 23, sleeve);
    v.box(10, 11, -3, -1, 23, 30, low);
    if (cuff) v.box(10, 11, -3, -1, 30, 30, cuff);
    v.box(10, 11, -3, -1, 31, 33, sk);
    return { x: 10, y: -2, z: 33 };
  }
  if (pose === 'out') { // straight out to the side; use on side +1
    v.box(5, 6, -2, 1, 19, 22, sleeve); v.box(7, 12, -1, 1, 20, 21, low);
    if (cuff) v.box(12, 12, -1, 1, 20, 21, cuff);
    v.box(13, 14, -1, 1, 20, 21, sk);
    return { x: 13, y: 0, z: 21 };
  }
  return null;
}

export function armsCrossed(v, o) {
  const { sleeve, skin } = o;
  for (const xs of [[-7, -6], [5, 6]]) v.box(xs[0], xs[1], -2, 2, 17, 22, sleeve);
  v.box(-7, 6, 3, 4, 16, 18, sleeve);
  v.box(-6, -4, 4, 5, 18, 19, skin.base);
  v.box(3, 5, 4, 5, 15, 16, skin.base);
}

// earbud plus a small signal-strength mark floating beside the head (R types). left: put the mark on the screen-left side.
export function signal(v, f, o = {}) {
  const { bud = true, left = false } = o;
  if (bud) v.box(8, 8, -2, -1, 27, 28, f.light);
  [0, 1, 2].forEach((i) => {
    const x = left ? -14 + i * 2 : 10 + i * 2, y = left ? 4 : -2;
    v.box(x, x, y, y, 36, 36 + i, f.light, { flat: 1 });
  });
}

// a disc standing in the x-z plane, one cube thick
export function disc(v, cx, cz, r, y, fn) {
  for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d <= r + 0.2) { const c = fn(d, x, z); if (c) v.set(x, y, z, c.c || c, c.o); }
  }
}
