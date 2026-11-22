// Voxel figurine kit (style 5, detailed version): engine, plinth, head, face, hair, body and arm parts.
// A figure is a grid of small cubes. x = the figure's left/right, y = depth (the figure faces +y), z = up.
const A = 6.8, B = 3.4, CZ = 7.8;

export const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const hex = (v) => '#' + v.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
export const mix = (a, b, t) => { const p = rgb(a), q = rgb(b); return hex(p.map((n, i) => n + (q[i] - n) * t)); };
export const dark = (h, t) => mix(h, '#000000', t);
export const lite = (h, t) => mix(h, '#ffffff', t);

const TOP = (h) => lite(h, 0.1);
const LEFT = (h) => { const [r, g, b] = rgb(h); return hex([r * 0.86, g * 0.87, b * 0.93]); };
const RIGHT = (h) => { const [r, g, b] = rgb(h); return hex([r * 0.7, g * 0.68, b * 0.76]); };
const SHADOW = '#080A16';
const noise = (x, y, z) => { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s) - 0.5; };

export class Vox {
  constructor() { this.m = new Map(); }
  set(x, y, z, c, o) { const k = x + ',' + y + ',' + z; if (c == null) this.m.delete(k); else this.m.set(k, Object.assign({ x, y, z, c }, o)); return this; }
  get(x, y, z) { return this.m.get(x + ',' + y + ',' + z); }
  solid(x, y, z) { const q = this.m.get(x + ',' + y + ',' + z); return !!q && q.a === undefined; }
  box(x0, x1, y0, y1, z0, z1, c, o) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, typeof c === 'function' ? c(x, y, z) : c, o);
    return this;
  }
  paint(x, y, z, c) { const q = this.get(x, y, z); if (q) q.c = c; return this; }
  // rounded blob: a box with its 8 corners (and optionally all edges) removed
  blob(x0, x1, y0, y1, z0, z1, c, o) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const e = (x === x0 || x === x1 ? 1 : 0) + (y === y0 || y === y1 ? 1 : 0) + (z === z0 || z === z1 ? 1 : 0);
      if (e < 3) this.set(x, y, z, c, o);
    }
    return this;
  }
}

const AO = {
  t: [[1, 0, 1, 1], [-1, 0, 1, 1], [0, 1, 1, 1], [0, -1, 1, 1], [1, 1, 1, .5], [1, -1, 1, .5], [-1, 1, 1, .5], [-1, -1, 1, .5]],
  l: [[1, 1, 0, 1], [-1, 1, 0, 1], [0, 1, 1, 1], [0, 1, -1, 1], [1, 1, 1, .5], [-1, 1, 1, .5], [1, 1, -1, .5], [-1, 1, -1, .5]],
  r: [[1, 1, 0, 1], [1, -1, 0, 1], [1, 0, 1, 1], [1, 0, -1, 1], [1, 1, 1, .5], [1, -1, 1, .5], [1, 1, -1, .5], [1, -1, -1, .5]],
};

export function renderVox(v, f, label, pfx) {
  const list = [...v.m.values()].sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z) || a.z - b.z);
  const P = (x, y, z) => [(x - y) * A, (x + y) * B - z * CZ];
  const SUF = {
    t: `l${A} ${B}l${-A} ${B}l${-A} ${-B}z`,
    l: `l${A} ${B}v${CZ}l${-A} ${-B}z`,
    r: `l${-A} ${B}v${CZ}l${A} ${-B}z`,
  };
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  const out = [];
  let cur = null;
  const push = (fill, alpha, px, py, kind) => {
    minX = Math.min(minX, px - A); maxX = Math.max(maxX, px + A); minY = Math.min(minY, py); maxY = Math.max(maxY, py + 2 * B + CZ);
    const d = `M${px.toFixed(1)} ${py.toFixed(1)}${SUF[kind]}`;
    if (cur && cur.fill === fill && cur.alpha === alpha) cur.d += d;
    else { cur = { fill, alpha, d }; out.push(cur); }
  };
  for (const q of list) {
    const { x, y, z } = q;
    const tr = q.a !== undefined;
    const S = (dx, dy, dz) => v.solid(x + dx, y + dy, z + dz);
    const open = (dx, dy, dz) => (tr ? !v.get(x + dx, y + dy, z + dz) : !S(dx, dy, dz));
    const base = q.n ? mix(q.c, noise(x, y, z) > 0 ? '#ffffff' : '#000000', Math.abs(noise(x, y, z)) * q.n) : q.c;
    const occ = (pts) => { let e = 0; for (const [dx, dy, dz, w] of pts) if (S(dx, dy, dz)) e += w; return 1 - Math.min(0.34, e * 0.1) * (q.ao === undefined ? 1 : q.ao); };
        const tone = (c, k) => (tr || q.flat ? c : mix(c, SHADOW, 1 - k));
    if (open(0, 0, 1)) {
      let k = occ(AO.t);
      for (let i = 2; i <= 22; i++) if (S(0, 0, i)) { k *= 0.8; break; }
      const [px, py] = P(x, y, z + 1);
      push(tone(TOP(q.t || base), k), q.a, px, py, 't');
    }
    if (open(0, 1, 0)) {
      let k = occ(AO.l);
      for (let i = 1; i <= 5; i++) if (S(0, 1, i)) { k *= 1 - 0.05 * (6 - i); break; }
      const [px, py] = P(x, y + 1, z + 1);
      push(tone(LEFT(q.l || base), k), q.a, px, py, 'l');
    }
    if (open(1, 0, 0)) {
      let k = occ(AO.r);
      for (let i = 1; i <= 5; i++) if (S(1, 0, i)) { k *= 1 - 0.05 * (6 - i); break; }
      const [px, py] = P(x + 1, y, z + 1);
      push(tone(q.r || RIGHT(base), k), q.a, px, py, 'r');
    }
  }
  const w = maxX - minX, h = maxY - minY;
  const s = Math.min(1, 376 / w, 434 / h);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const floorY = 232 + (maxY - cy) * s;
  const body = out.map((o) => `<path d="${o.d}" fill="${o.fill}" stroke="${o.fill}"${o.alpha !== undefined ? ` fill-opacity="${o.alpha}" stroke-opacity="0"` : ''}/>`).join('');
  return `<svg viewBox="0 0 400 460" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">
<defs>
<radialGradient id="${pfx}bg" cx="50%" cy="44%" r="80%"><stop offset="0" stop-color="${mix(f.deep, f.dark, 0.38)}"/><stop offset=".62" stop-color="${mix(f.tile, f.deep, 0.55)}"/><stop offset="1" stop-color="${f.tile}"/></radialGradient>
<filter id="${pfx}bl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="11"/></filter>
</defs>
<rect width="400" height="460" fill="url(#${pfx}bg)"/>
<ellipse cx="200" cy="${(floorY - 40 * s).toFixed(1)}" rx="${(168 * s).toFixed(1)}" ry="${(46 * s).toFixed(1)}" fill="#02030A" opacity=".72" filter="url(#${pfx}bl)"/>
<g transform="translate(200 232) scale(${s.toFixed(4)}) translate(${(-cx).toFixed(1)} ${(-cy).toFixed(1)})" stroke-width=".6" stroke-linejoin="round">${body}</g>
</svg>`;
}

