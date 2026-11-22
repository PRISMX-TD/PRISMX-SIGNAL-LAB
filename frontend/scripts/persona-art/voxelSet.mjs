// The 16 personas as voxel figurines. Each builder places parts from voxelParts on a plinth.
import { FAM, SKIN, HAIR, PERSONAS } from './personas.mjs';
import { Vox, renderVox, mix, dark, lite } from './voxelKit.mjs';
import { plinth, head, face, hairShell, body, vneck, arm, armsCrossed, signal, disc, INK, CHAR } from './voxelParts.mjs';

const CREAM = '#F1F4FD', WHITE = '#FFFFFF', STEEL = '#C9D1E2', WOOD = '#C99A62', GOLD = '#D9B36A', BLACK = '#14161F';

// ---------------------------------------------------------------- small props (stand on z = 8)
function pawn(v, cx, cy, c, base) {
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) if (Math.abs(x) + Math.abs(y) < 4) v.set(cx + x, cy + y, 8, base || c);
  v.box(cx - 1, cx + 1, cy - 1, cy + 1, 9, 9, c);
  for (let z = 10; z <= 12; z++) for (const [x, y] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) v.set(cx + x, cy + y, z, c);
  v.box(cx - 1, cx + 1, cy - 1, cy + 1, 13, 13, c);
  v.blob(cx - 1, cx + 1, cy - 1, cy + 1, 14, 16, c);
}
function rook(v, cx, cy, c) {
  v.box(cx - 2, cx + 2, cy - 2, cy + 2, 8, 8, c);
  v.box(cx - 1, cx + 1, cy - 1, cy + 1, 9, 13, c);
  v.box(cx - 2, cx + 2, cy - 2, cy + 2, 14, 14, c);
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) if ((Math.abs(x) === 2 || Math.abs(y) === 2) && (x + y) % 2 === 0) v.set(cx + x, cy + y, 15, c);
}
const eachTop = (fn) => { for (let x = -7; x <= 6; x++) for (let y = -6; y <= 3; y++) fn(x, y); };

const build = {
  // 布局者: silver hair, round glasses, blazer over a roll-neck, tea in hand, chessboard plinth
  AGLZ(v, f, sk, h) {
    plinth(v, f, 'AGLZ', (x, y) => ((Math.floor((x + 10) / 2) + Math.floor((y + 10) / 2)) % 2 ? mix(f.dark, f.light, 0.32) : f.dark));
    body(v, { main: f.main });
    vneck(v, CHAR, [3, 3, 2, 2, 1, 1, 1], lite(f.main, 0.3));
    v.box(-2, 1, 3, 3, 22, 22, '#3A4157');
    v.set(0, 3, 14, f.ink); v.set(3, 2, 19, WHITE); v.set(4, 2, 19, WHITE);
    v.box(-5, 4, -3, 2, 12, 12, dark(f.main, 0.14));
    const a = { sleeve: f.main, skin: sk, cuff: lite(f.main, 0.3) };
    arm(v, -1, 'in', a); arm(v, 1, 'in', a);
    v.box(-3, 2, 6, 9, 19, 19, '#DDE3F2');
    v.box(-2, 1, 6, 8, 20, 21, WHITE); v.box(-2, 1, 6, 8, 21, 21, WHITE, { t: '#B9762F' });
    v.set(2, 7, 20, WHITE);
    v.set(-1, 7, 22, WHITE, { a: 0.5 }); v.set(0, 7, 23, WHITE, { a: 0.42 }); v.set(-1, 7, 24, WHITE, { a: 0.3 });
    head(v, sk);
    face(v, sk, { eyes: 'shut', brows: 'flat', mouth: 'smile', browC: '#8E96AD', glasses: { c: '#1D2A66' } });
    hairShell(v, h, { layers: [[0, 4], [1, 3], [3, 0]], sideY: 0, sideZ: 30, backZ: 26 });
    v.set(-6, 4, 33, h.base); v.set(5, 4, 33, h.base);
    pawn(v, 7, 6, CREAM, f.light);
    rook(v, 6, -7, mix(f.deep, f.dark, 0.6));
  },

  // 舵手: beard, captain's cap, pea coat, both hands on a ship's wheel
  AGLM(v, f, sk, h) {
    plinth(v, f, 'AGLM', (x, y) => ((y + 10) % 3 === 0 ? dark(f.dark, 0.2) : null));
    const navy = '#1C2A5E';
    body(v, { main: navy, legs: '#E4E8F3' });
    vneck(v, WHITE, [2, 2, 1], lite(navy, 0.22));
    for (const z of [14, 17, 20]) { v.set(-2, 3, z, GOLD); v.set(1, 3, z, GOLD); }
    const a = { sleeve: navy, skin: sk, cuff: GOLD };
    arm(v, -1, 'in', a); arm(v, 1, 'in', a);
    disc(v, -0.5, 18.5, 5.2, 8, (d, x, z) => {
      const dx = Math.abs(x + 0.5), dz = Math.abs(z - 18.5);
      if (d >= 4.1) return WOOD;
      if (d < 1.6) return GOLD;
      return dx < 1 || dz < 1 || Math.abs(dx - dz) < 0.8 ? dark(WOOD, 0.2) : null;
    });
    for (const [x, z] of [[-1, 25], [0, 25], [-7, 18], [-7, 19], [6, 18], [6, 19]]) v.set(x, 8, z, CREAM);
    v.box(-1, 0, 8, 9, 8, 12, dark(WOOD, 0.4));
    head(v, sk);
    face(v, sk, { eyes: 'open', brows: 'flat', mouth: 'flat', browC: h.shade, beard: 'trim', beardC: h.base, blush: false });
    hairShell(v, h, { layers: [[0, 4]], sideY: 0, sideZ: 29, backZ: 27 });
    v.box(-8, 7, -7, 4, 35, 35, navy);
    v.box(-8, 7, -7, 4, 36, 37, '#F1F3FA');
    v.box(-9, 8, -8, 5, 38, 38, '#F1F3FA');
    for (const x of [-1, 0]) for (const z of [36, 37]) v.set(x, 4, z, GOLD);
    v.box(-6, 5, 5, 7, 35, 35, '#101838');
  },

  // 钟表匠: auburn bob, loupe over one eye, apron, a big pocket watch
  AGQZ(v, f, sk, h) {
    plinth(v, f, 'AGQZ', (x, y) => {
      const d = Math.hypot(x + 0.5, y + 0.5), a = (Math.atan2(y + 0.5, x + 0.5) * 6) / Math.PI;
      return d > 7 && d < 9.3 && Math.abs(a - Math.round(a)) < 0.17 ? f.light : d >= 5.8 && d < 6.7 ? mix(f.dark, f.light, 0.3) : null;
    });
    const shirt = '#EEF1F8';
    body(v, { main: shirt });
    v.set(-1, 2, 22, sk.base); v.set(0, 2, 22, sk.base);
    v.box(-4, 3, 3, 3, 12, 19, f.main);
    for (const z of [20, 21, 22]) { v.set(-3, 3, z, f.dark); v.set(2, 3, z, f.dark); }
    v.box(-4, 3, 3, 3, 16, 16, f.dark);
    v.box(-2, 1, 3, 3, 13, 14, dark(f.main, 0.18));
    arm(v, -1, 'fwd', { sleeve: shirt, skin: sk, bare: true });
    arm(v, 1, 'down', { sleeve: shirt, skin: sk, bare: true });
    for (let x = -8; x <= -5; x++) for (let z = 20; z <= 23; z++) {
      const corner = (x === -8 || x === -5) && (z === 20 || z === 23), hole = (x === -7 || x === -6) && (z === 21 || z === 22);
      if (!corner && !hole) v.set(x, 7, z, GOLD);
    }
    head(v, sk);
    face(v, sk, { eyes: ['open', null], brows: ['flat', null], mouth: 'smile', browC: h.shade, lash: true });
    for (let y = 5; y <= 7; y++) for (let x = 1; x <= 4; x++) for (let z = 27; z <= 30; z++) if (!((x === 1 || x === 4) && (z === 27 || z === 30))) v.set(x, y, z, CHAR);
    for (const x of [2, 3]) for (const z of [28, 29]) v.set(x, 7, z, '#EAF2FF', { flat: 1 });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 2, sideZ: 24, backZ: 23, fringe: (x) => (x < -2 ? 3 : x < 1 ? 2 : 0), locks: 24 });
    disc(v, 5, 12.5, 4.3, 6, () => GOLD);
    disc(v, 5, 12.5, 4.3, 7, (d, x, z) => (d > 3.3 ? GOLD : (x === 5 && z >= 12 && z <= 15) || (z === 12 && x >= 5 && x <= 7) ? INK : CREAM));
    v.box(4, 5, 6, 7, 17, 17, GOLD); v.set(4, 6, 18, GOLD); v.set(5, 6, 18, GOLD);
    for (const [cx, cy] of [[-7, 7], [-4, 8]]) for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) v.set(cx + x, cy + y, 8, f.light);
  },

  // 游击手: headband, vest over a tee, binoculars, map pins on the plinth
  AGQM(v, f, sk, h) {
    plinth(v, f, 'AGQM', (x, y) => { const d = Math.hypot(x + 0.5, y + 0.5); return (d > 4 && d < 5) || (d > 7.6 && d < 8.6) ? mix(f.dark, f.light, 0.35) : null; });
    const tee = '#D9DEEA', vest = '#1C2550';
    body(v, { main: vest, legs: '#3A4763', shoe: '#1B1E27' });
    v.box(-5, 4, -3, 2, 12, 12, tee);
    for (let z = 13; z <= 22; z++) { v.set(-1, 2, z, tee); v.set(0, 2, z, tee); }
    v.set(-2, 2, 22, tee); v.set(1, 2, 22, tee);
    v.box(-4, -3, 3, 3, 14, 15, lite(vest, 0.2)); v.box(2, 3, 3, 3, 14, 15, lite(vest, 0.2));
    v.box(-2, 1, 3, 4, 17, 19, BLACK); v.set(-2, 5, 18, f.light); v.set(1, 5, 18, f.light);
    for (const z of [20, 21]) { v.set(-2, 3, z, CHAR); v.set(1, 3, z, CHAR); }
    arm(v, -1, 'down', { sleeve: tee, skin: sk, bare: true });
    arm(v, 1, 'down', { sleeve: tee, skin: sk, bare: true });
    head(v, sk);
    face(v, sk, { eyes: 'open', brows: ['flat', 'up'], mouth: 'smirk', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 0, sideZ: 30, backZ: 28, stripe: 0 });
    eachTop((x, y) => { if ((x * 7 + y * 13 + 100) % 5 === 0) v.set(x, y, 37, h.base); });
    v.box(-6, 5, 5, 5, 33, 34, f.main);
    for (const x of [-8, 7]) v.box(x, x, -7, 3, 33, 34, f.main);
    v.box(-8, 7, -7, -7, 33, 34, f.main);
    v.set(-7, 4, 33, f.main); v.set(6, 4, 33, f.main);
    v.box(8, 9, -6, -5, 31, 34, f.main); v.box(9, 10, -6, -6, 28, 31, f.dark);
    v.box(7, 7, 6, 6, 8, 11, CHAR); v.blob(6, 8, 5, 7, 12, 14, f.light);
    v.box(-8, -8, 7, 7, 8, 9, CHAR); v.box(-8, -8, 7, 7, 10, 11, CREAM);
    for (const [x, y] of [[-6, 8], [-4, 8], [-2, 8], [1, 8], [3, 7], [5, 7]]) v.get(x, y, 7).t = CREAM;
  },

  // 磐石: bald, full beard, arms folded, a boulder beside him
  AXLZ(v, f, sk, h) {
    plinth(v, f, 'AXLZ', (x, y) => ((x * 3 + y * 5 + 90) % 11 === 0 ? dark(f.dark, 0.22) : null));
    body(v, { main: f.main, shoe: '#1B1E27' });
    v.box(-5, 4, -3, 2, 12, 12, dark(f.main, 0.2)); v.box(-3, 2, 2, 2, 22, 22, dark(f.main, 0.2));
    armsCrossed(v, { sleeve: f.main, skin: sk });
    head(v, sk);
    face(v, sk, { eyes: 'calm', brows: 'flat', mouth: 'flat', beard: 'full', beardC: h.base, browC: h.base, blush: false });
    for (const [x, y] of [[-4, 0], [-3, 0], [-4, -1]]) v.get(x, y, 34).t = lite(sk.base, 0.4);
    v.blob(4, 9, 3, 8, 8, 12, '#8E93A3', { n: 0.12 }); v.blob(5, 8, 4, 7, 13, 14, '#9CA1B1', { n: 0.12 });
    v.set(-8, 7, 8, '#8E93A3'); v.box(-7, -6, 8, 8, 8, 8, '#9CA1B1');
  },

  // 谈判家: sleek high ponytail, blazer, phone at the ear, briefcase
  AXLM(v, f, sk, h) {
    plinth(v, f, 'AXLM', (x, y) => ((x + y + 40) % 5 === 0 ? mix(f.dark, f.light, 0.28) : null));
    body(v, { main: f.main, shoe: f.dark });
    vneck(v, WHITE, [3, 2, 2, 1, 1], lite(f.main, 0.25));
    v.set(0, 3, 15, f.ink);
    arm(v, -1, 'down', { sleeve: f.main, skin: sk, cuff: WHITE });
    v.box(5, 6, -2, 1, 18, 22, f.main); v.box(7, 9, -2, 0, 18, 20, f.main); v.box(9, 10, -2, 0, 20, 26, f.main);
    head(v, sk);
    face(v, sk, { eyes: 'open', lash: true, brows: ['flat', 'high'], mouth: 'smirk', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4]], sideY: 1, sideZ: 30, backZ: 28 });
    v.blob(-2, 1, -8, -5, 36, 38, h.base);
    for (let x = -2; x <= 1; x++) for (let y = -8; y <= -5; y++) v.paint(x, y, 36, f.light);
    v.box(2, 4, -9, -8, 33, 37, h.base); v.box(4, 6, -10, -9, 29, 34, h.base); v.box(6, 8, -10, -9, 25, 30, h.base);
    v.box(8, 8, -3, 0, 26, 31, BLACK);
    v.box(9, 9, -2, 0, 27, 29, sk.base);
    v.box(-9, -5, 6, 8, 8, 11, f.dark); v.box(-9, -5, 6, 8, 10, 10, dark(f.dark, 0.25));
    v.set(-8, 7, 12, INK); v.set(-6, 7, 12, INK); v.box(-8, -6, 7, 7, 13, 13, INK); v.set(-7, 8, 10, GOLD);
  },

  // 快刀手: topknot, wrap jacket with a sash, kitchen knife held up, chopping board
  AXQZ(v, f, sk, h) {
    plinth(v, f, 'AXQZ', (x, y) => (Math.abs(x - y) % 7 === 0 && Math.abs(x + y) < 9 ? mix(f.dark, f.light, 0.4) : null));
    const robe = '#2B2F3D';
    body(v, { main: robe, legs: '#22252F' });
    v.box(-5, 4, -3, 2, 14, 15, f.main); v.box(-2, -1, 3, 3, 13, 15, f.dark);
    v.set(-1, 2, 22, sk.base); v.set(0, 2, 22, sk.base); v.set(-1, 2, 21, sk.base);
    for (let i = 0; i < 6; i++) { v.set(-3 + i, 3, 22 - i, f.main); v.set(-2 + i, 3, 22 - i, f.main); }
    for (let i = 0; i < 3; i++) v.set(3 - i, 3, 22 - i, f.main);
    arm(v, -1, 'down', { sleeve: robe, skin: sk, cuff: f.main });
    arm(v, 1, 'up', { sleeve: robe, skin: sk, cuff: f.main });
    v.box(10, 11, -2, -2, 34, 34, '#4A3326');
    for (let z = 35; z <= 41; z++) for (let x = 9; x <= (z > 40 ? 9 : z > 39 ? 10 : 11); x++) v.set(x, -2, z, x === 9 ? lite(STEEL, 0.5) : STEEL);
    head(v, sk);
    face(v, sk, { eyes: 'line', brows: 'angry', mouth: 'smirk', blush: false, browC: h.base });
    hairShell(v, h, { layers: [[0, 4]], sideY: 0, sideZ: 30, backZ: 28 });
    v.blob(-2, 1, -3, 0, 36, 38, h.base);
    for (let x = -2; x <= 1; x++) for (let y = -3; y <= 0; y++) v.paint(x, y, 36, f.main);
    v.box(7, 7, 1, 1, 28, 30, h.base);
    v.box(-9, -4, 5, 8, 8, 8, '#E2CFA8');
    v.set(-8, 6, 9, f.main); v.set(-6, 7, 9, f.main); v.set(-5, 5, 9, f.light); v.box(-8, -7, 8, 8, 9, 9, f.main);
  },

  // 闪击手: boxer. Short crop with faded sides, tape across the nose, white tank with a bolt on the chest, red gloves
  // (one jab thrown at the viewer, one up by the chin), ring corner and a bolt on the mat
  AXQM(v, f, sk, h) {
    const mat = mix(f.dark, f.light, 0.14), BOLT = '#FFD95A', glove = lite(f.main, 0.05), tank = '#F4F5FA', shorts = '#22252F', tape = '#FFF6E6';
    const onBolt = (x, y) => (y >= 0 && y <= 3 && (x === 5 || x === 6)) || ((y === 4 || y === 5) && x >= 5 && x <= 8) || (y >= 6 && y <= 8 && (x === 7 || x === 8));
    plinth(v, f, 'AXQM', (x, y) => (onBolt(x, y) ? BOLT : mat));
    for (const [px, py] of [[-10, -10], [-10, 8], [8, -10]]) { v.box(px, px + 1, py, py + 1, 8, 14, CREAM); v.box(px, px + 1, py, py + 1, 15, 15, f.main); }
    for (const z of [10, 13]) { const c = z === 13 ? f.light : CREAM; v.box(-10, -10, -8, 7, z, z, c); v.box(-8, 7, -10, -10, z, z, c); }
    body(v, { main: tank, legs: shorts, shoe: WHITE, belt: f.main });
    v.box(-5, -2, -3, 1, 9, 9, WHITE); v.box(1, 4, -3, 1, 9, 9, WHITE);
    for (const x of [-5, 4]) for (let y = -3; y <= 1; y++) for (const z of [10, 11]) v.paint(x, y, z, f.main);
    for (let x = -2; x <= 1; x++) v.set(x, 2, 22, sk.base);
    v.set(-1, 2, 21, sk.base); v.set(0, 2, 21, sk.base);
    for (const x of [-5, 4]) v.box(x, x, -3, 2, 20, 22, sk.base);
    for (const [x, z] of [[0, 20], [1, 20], [-1, 19], [0, 19], [-2, 18], [-1, 18], [-3, 17], [-2, 17], [-1, 17], [0, 17], [1, 17], [0, 16], [1, 16], [-1, 15], [0, 15], [-2, 14], [-1, 14], [-3, 13]]) v.get(x, 2, z).l = f.main;
    // jab arm (screen left): straight out toward the viewer, glove past the edge of the plinth
    v.box(-7, -6, -2, 1, 19, 22, sk.base);
    v.box(-7, -6, 2, 6, 21, 22, sk.base);
    v.blob(-9, -5, 7, 11, 19, 23, glove);
    for (let x = -9; x <= -5; x++) for (let z = 19; z <= 23; z++) v.paint(x, 7, z, CREAM);
    v.box(-4, -4, 8, 9, 20, 21, glove);
    // guard arm (screen right): glove up beside the chin
    v.box(5, 6, -2, 1, 17, 22, sk.base);
    v.box(7, 8, 0, 3, 17, 19, sk.base);
    v.blob(7, 10, 1, 4, 20, 24, glove);
    for (let x = 7; x <= 10; x++) for (let y = 1; y <= 4; y++) v.paint(x, y, 20, CREAM);
    v.box(8, 9, 5, 5, 21, 22, glove);
    head(v, sk);
    face(v, sk, { eyes: 'open', brows: 'angry', mouth: 'smirk', browC: h.base, blush: false });
    for (let x = -3; x <= 2; x++) v.set(x, 4, 27, tape, { ao: 0.4 });
    v.set(-1, 5, 27, tape, { ao: 0.4 }); v.set(0, 5, 27, tape, { ao: 0.4 });
    // short crop with faded sides: stubble on the side of the head and the temples, a small quiff in front
    const fade = (z) => mix(sk.base, h.base, z >= 32 ? 0.6 : z >= 30 ? 0.38 : 0.18);
    for (let y = -5; y <= 3; y++) for (let z = 28; z <= 33; z++) { const q = v.get(6, y, z); if (q) { q.c = fade(z); q.r = dark(fade(z), 0.24); } }
    for (const x of [-6, 5]) for (let z = 31; z <= 33; z++) v.set(x, 4, z, fade(z + 1), { ao: 0.4 });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 0, sideZ: 33, backZ: 31 });
    v.box(-5, 4, 0, 3, 37, 37, h.base); v.box(-3, 2, 2, 4, 38, 38, h.base);
  },

  // 执行官: low bun, suit and tie, earpiece, clipboard full of ticks
  RGLZ(v, f, sk, h) {
    plinth(v, f, 'RGLZ', (x, y) => ((y + 10) % 3 === 1 ? mix(f.dark, f.light, 0.22) : null));
    const suit = '#3A3F4D';
    body(v, { main: suit, legs: suit });
    vneck(v, WHITE, [3, 2, 2, 1, 1, 1], '#5A6072');
    for (let z = 17; z <= 21; z++) { v.set(-1, 2, z, f.main); v.set(0, 2, z, f.main); }
    v.set(-1, 2, 21, f.dark); v.set(0, 2, 21, f.dark); v.set(0, 3, 14, INK);
    arm(v, -1, 'in', { sleeve: suit, skin: sk, cuff: WHITE });
    arm(v, 1, 'down', { sleeve: suit, skin: sk, cuff: WHITE });
    v.box(-7, -2, 8, 8, 15, 22, '#2B2F3D');
    for (let x = -6; x <= -3; x++) for (let z = 16; z <= 21; z++) v.get(x, 8, z).l = WHITE;
    for (const z of [20, 18, 16]) { v.get(-6, 8, z).l = f.main; v.get(-4, 8, z).l = '#B9BED0'; v.get(-3, 8, z).l = '#B9BED0'; }
    v.box(-5, -4, 9, 9, 22, 22, STEEL);
    head(v, sk);
    face(v, sk, { eyes: 'open', lash: true, brows: 'flat', mouth: 'flat', browC: h.base });
    hairShell(v, h, { layers: [[0, 4]], sideY: 1, sideZ: 29, backZ: 25, stripe: 0 });
    for (let y = -6; y <= 4; y++) v.paint(-1, y, 35, mix(h.base, '#FFFFFF', 0.22));
    v.blob(4, 8, -10, -7, 25, 29, h.base);
    signal(v, f);
    v.box(4, 8, 5, 8, 8, 8, WHITE); v.box(4, 8, 5, 8, 9, 9, f.light); v.box(5, 9, 4, 7, 10, 10, WHITE);
  },

  // 调校师: curly hair, big headphones, dungarees, wrench held up, toolbox
  RGLM(v, f, sk, h) {
    plinth(v, f, 'RGLM', (x, y) => { const d1 = Math.hypot(x + 5, y - 5), d2 = Math.hypot(x - 5, y + 5); return (d1 > 2.4 && d1 < 3.4) || (d2 > 2.4 && d2 < 3.4) ? mix(f.dark, f.light, 0.4) : null; });
    const tee = '#8E95A6';
    body(v, { main: tee, legs: dark(f.main, 0.12), shoe: '#3A2C28' });
    v.box(-5, 4, -3, 2, 12, 14, f.main);
    v.box(-3, 2, 3, 3, 12, 18, f.main);
    for (const z of [19, 20, 21, 22]) { v.set(-3, 3, z, f.main); v.set(2, 3, z, f.main); }
    v.set(-3, 3, 18, f.light); v.set(2, 3, 18, f.light);
    v.box(-1, 0, 3, 3, 15, 16, dark(f.main, 0.2));
    arm(v, -1, 'down', { sleeve: tee, skin: sk, bare: true });
    arm(v, 1, 'up', { sleeve: tee, skin: sk, bare: true });
    v.box(10, 11, -2, -2, 34, 39, STEEL);
    for (let x = 9; x <= 12; x++) v.set(x, -2, 40, STEEL);
    for (const z of [41, 42]) { v.set(9, -2, z, STEEL); v.set(12, -2, z, STEEL); }
    head(v, sk);
    face(v, sk, { eyes: ['shut', 'open'], brows: ['angry', 'flat'], mouth: 'small', beard: 'stubble', beardC: h.base, blush: false, browC: h.base });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 1, sideZ: 28, backZ: 26, stripe: 0, fringe: (x) => 1 + ((x + 9) % 3 === 0 ? 1 : 0) });
    eachTop((x, y) => { if ((x * 5 + y * 3 + 60) % 4 === 0) v.set(x, y, 37, h.base); });
    v.box(-8, 7, -2, -1, 38, 38, f.dark);
    for (const x of [-9, 8]) v.box(x, x, -2, -1, 31, 38, f.dark);
    v.box(8, 9, -4, 0, 25, 30, f.main); v.box(9, 9, -3, -1, 26, 29, f.light);
    v.box(-10, -9, -4, 0, 25, 30, f.main);
    signal(v, f, { bud: false, left: true });
    v.box(-9, -5, 6, 8, 8, 10, f.dark); v.box(-9, -5, 6, 8, 11, 11, dark(f.dark, 0.25));
    v.set(-8, 7, 12, INK); v.set(-6, 7, 12, INK); v.box(-8, -6, 7, 7, 13, 13, INK); v.set(-7, 8, 10, f.light);
  },

  // 守纪者: peaked cap, uniform shirt, whistle, stopwatch in hand, lane lines on the plinth
  RGQZ(v, f, sk, h) {
    plinth(v, f, 'RGQZ', (x, y) => ((y + 10) % 5 === 2 ? CREAM : null));
    body(v, { main: f.main, legs: '#22283A', belt: '#1B1E27' });
    for (let z = 13; z <= 21; z++) v.set(-1, 2, z, dark(f.main, 0.22));
    v.box(-2, 1, 2, 2, 22, 22, lite(f.main, 0.3));
    v.box(-4, -3, 2, 2, 18, 19, dark(f.main, 0.16)); v.box(2, 3, 2, 2, 18, 19, dark(f.main, 0.16));
    v.set(-5, 2, 22, f.light); v.set(4, 2, 22, f.light); v.set(-1, 2, 12, STEEL); v.set(0, 2, 12, STEEL);
    v.set(-2, 3, 21, CREAM); v.set(1, 3, 21, CREAM); v.set(-1, 3, 20, CREAM); v.set(0, 3, 20, CREAM);
    v.set(0, 3, 19, STEEL); v.set(0, 3, 18, STEEL); v.set(1, 3, 18, STEEL);
    arm(v, -1, 'fwd', { sleeve: f.main, skin: sk, bare: true });
    arm(v, 1, 'down', { sleeve: f.main, skin: sk, bare: true });
    for (let x = -8; x <= -5; x++) for (let z = 20; z <= 23; z++) if (!((x === -8 || x === -5) && (z === 20 || z === 23))) { v.set(x, 6, z, f.light); v.set(x, 7, z, CREAM); }
    v.get(-7, 7, 22).l = INK; v.get(-7, 7, 21).l = INK; v.get(-6, 7, 21).l = INK;
    v.box(-7, -6, 6, 7, 24, 24, STEEL);
    head(v, sk);
    face(v, sk, { eyes: 'open', brows: 'flat', mouth: 'smile', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4]], sideY: 0, sideZ: 30, backZ: 28 });
    v.box(-8, 7, -7, 4, 35, 35, dark(f.main, 0.35));
    v.box(-8, 7, -7, 4, 36, 37, f.main);
    v.box(-8, 7, -8, 5, 38, 38, f.main);
    for (const x of [-1, 0]) for (const z of [36, 37]) v.set(x, 4, z, f.light);
    v.box(-6, 5, 5, 7, 35, 35, '#12151C');
    signal(v, f);
    v.box(6, 8, 5, 7, 8, 8, CHAR);
    for (let z = 9; z <= 14; z++) for (const [x, y] of [[7, 6], [6, 6], [8, 6], [7, 5], [7, 7]]) v.set(x, y, z, z % 2 ? WHITE : f.main);
    v.set(7, 6, 15, CHAR);
  },

  // 试探者: fringe and ponytail, round glasses, windbreaker, magnifier held up, a puddle to test
  RGQM(v, f, sk, h) {
    plinth(v, f, 'RGQM', (x, y) => { const d = Math.hypot((x + 4) / 5.2, (y - 6) / 2.8); return d < 1 ? (d > 0.72 ? lite(f.light, 0.35) : mix(f.main, f.light, 0.6)) : null; });
    body(v, { main: f.main, shoe: lite(f.main, 0.5) });
    v.box(-5, 4, -3, 2, 12, 12, dark(f.main, 0.22));
    for (let z = 13; z <= 22; z++) v.set(-1, 2, z, lite(f.main, 0.45));
    v.box(-3, 2, 3, 3, 22, 22, lite(f.main, 0.18));
    v.box(-4, -3, 2, 2, 14, 15, dark(f.main, 0.16)); v.box(2, 3, 2, 2, 14, 15, dark(f.main, 0.16));
    arm(v, -1, 'down', { sleeve: f.main, skin: sk, cuff: dark(f.main, 0.28) });
    arm(v, 1, 'up', { sleeve: f.main, skin: sk, cuff: dark(f.main, 0.28) });
    v.box(10, 11, -2, -2, 34, 36, '#3A2C28');
    disc(v, 10.5, 40.5, 3.4, -2, (d) => (d > 2.3 ? CHAR : { c: '#CFF3FF', o: { a: 0.45 } }));
    head(v, sk);
    face(v, sk, { glasses: { c: '#2B3144' }, eyes: 'open', brows: 'worried', mouth: 'small', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 1, sideZ: 27, backZ: 27, fringe: (x) => (x < -4 || x > 3 ? 3 : 2) });
    v.blob(3, 7, -10, -7, 29, 33, h.base); v.box(5, 8, -10, -8, 24, 29, h.base);
    signal(v, f, { left: true });
  },

  // 半信者: messy hair, hoodie, one earbud dangling, a two-tone coin above the hand
  RXLZ(v, f, sk, h) {
    plinth(v, f, 'RXLZ', (x, y) => (x + y < -1 ? null : mix(f.dark, f.light, 0.42)));
    body(v, { main: f.main, legs: '#3A4763', shoe: WHITE });
    v.box(-5, 4, -3, 2, 12, 12, dark(f.main, 0.22));
    v.box(-3, 2, 2, 2, 13, 15, dark(f.main, 0.15));
    for (const x of [-4, -3, 2, 3]) v.set(x, 3, 22, lite(f.main, 0.28));
    v.set(-2, 2, 21, CREAM); v.set(-2, 2, 20, CREAM); v.set(1, 2, 21, CREAM); v.set(1, 2, 20, CREAM); v.set(1, 2, 19, CREAM);
    v.box(-4, 3, -5, -4, 20, 23, dark(f.main, 0.1));
    for (const z of [21, 20, 19]) v.set(3, 3, z, WHITE);
    v.set(3, 3, 18, f.light); v.set(3, 4, 18, f.light);
    arm(v, -1, 'fwd', { sleeve: f.main, skin: sk, cuff: dark(f.main, 0.22) });
    arm(v, 1, 'down', { sleeve: f.main, skin: sk, cuff: dark(f.main, 0.22) });
    for (let x = -8; x <= -5; x++) for (let z = 22; z <= 25; z++) if (!((x === -8 || x === -5) && (z === 22 || z === 25))) v.set(x, 7, z, x <= -7 ? CREAM : f.dark, { flat: 1 });
    v.set(-7, 7, 20, CREAM, { a: 0.4 }); v.set(-6, 7, 20, CREAM, { a: 0.4 });
    head(v, sk);
    face(v, sk, { eyes: 'open', brows: ['flat', 'up'], mouth: 'smirk', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 1, sideZ: 28, backZ: 26, stripe: 0, fringe: (x) => [1, 2, 1, 2, 2, 1, 1, 2, 2, 1, 2, 1][x + 6] });
    eachTop((x, y) => { if ((x * 11 + y * 7 + 70) % 6 === 0) v.set(x, y, 37, h.base); });
    signal(v, f);
  },

  // 乘风者: long hair and scarf blown sideways, goggles on the forehead, paper plane overhead
  RXLM(v, f, sk, h) {
    plinth(v, f, 'RXLM', (x, y) => ((y + 20 + Math.round(Math.sin(x / 2.2) * 1.6)) % 5 === 0 ? mix(f.dark, f.light, 0.42) : null));
    const rib = dark(f.main, 0.28), sc = '#FFF3D6';
    body(v, { main: f.main, shoe: '#5A3A28' });
    v.box(-5, 4, -3, 2, 12, 12, rib);
    for (let z = 13; z <= 20; z++) v.set(-1, 2, z, dark(f.main, 0.32));
    for (const x of [-4, -3, 2, 3]) { v.set(x, 3, 22, CREAM); v.set(x, 3, 21, CREAM); }
    v.box(-2, 1, 3, 3, 21, 22, sc);
    v.box(7, 9, -6, -5, 20, 21, sc); v.box(10, 12, -7, -6, 21, 22, sc); v.box(13, 14, -7, -7, 22, 23, sc);
    arm(v, -1, 'down', { sleeve: f.main, skin: sk, cuff: rib });
    arm(v, 1, 'up', { sleeve: f.main, skin: sk, cuff: rib });
    v.box(9, 14, -2, -2, 36, 36, WHITE); v.box(9, 11, -3, -1, 36, 36, WHITE); v.box(9, 12, -2, -2, 35, 35, '#D9DEEA');
    head(v, sk);
    face(v, sk, { eyes: 'happy', brows: 'flat', mouth: 'grin', browC: h.base });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 2, sideZ: 21, backZ: 18, stripe: 0, locks: 24 });
    v.box(8, 10, -7, -5, 24, 31, h.base); v.box(11, 13, -7, -6, 26, 30, h.base); v.box(14, 15, -7, -6, 28, 29, h.base);
    v.box(-6, 5, 5, 5, 33, 33, '#2B2F3D');
    for (const x of [-8, 7]) v.box(x, x, -7, 3, 33, 33, '#2B2F3D');
    v.box(-5, -2, 5, 6, 32, 34, '#3A3F4D'); v.box(1, 4, 5, 6, 32, 34, '#3A3F4D');
    for (const x of [-4, -3, 2, 3]) v.set(x, 6, 33, f.light);
    signal(v, f, { left: true });
  },

  // 搭车客: beanie with a pompom, stubble, puffer vest and rucksack, thumb out, road and sign on the plinth
  RXQZ(v, f, sk, h) {
    plinth(v, f, 'RXQZ', (x, y) => (y >= 4 && y <= 8 ? (y === 6 && (x + 10) % 4 < 2 ? CREAM : '#2B2F3D') : null));
    const vest = '#2B3144', brim = lite(f.main, 0.28);
    body(v, { main: vest, legs: '#3A4763', shoe: '#5A3A28' });
    v.box(-5, 4, -3, 2, 12, 12, f.main);
    for (let z = 13; z <= 22; z++) { v.set(-1, 2, z, f.main); v.set(0, 2, z, f.main); }
    for (const z of [15, 18, 21]) for (const x of [-5, -4, -3, -2, 1, 2, 3, 4]) v.set(x, 2, z, dark(vest, 0.3));
    for (let z = 15; z <= 22; z++) { v.set(-4, 3, z, f.dark); v.set(3, 3, z, f.dark); }
    v.box(-4, 3, -6, -4, 13, 21, f.dark);
    arm(v, -1, 'down', { sleeve: f.main, skin: sk, cuff: dark(f.main, 0.22) });
    arm(v, 1, 'out', { sleeve: f.main, skin: sk, cuff: dark(f.main, 0.22) });
    v.set(13, 0, 22, sk.base); v.set(13, 0, 23, sk.base);
    head(v, sk);
    face(v, sk, { eyes: 'open', brows: 'flat', mouth: 'grin', beard: 'stubble', beardC: '#8A6A3A', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4]], sideY: 0, sideZ: 30, backZ: 28 });
    v.box(-8, 7, -7, 4, 34, 35, brim); v.box(-6, 5, 5, 5, 33, 35, brim);
    v.box(-8, 7, -7, 4, 36, 37, f.main); v.box(-7, 6, -6, 3, 38, 38, f.main); v.box(-5, 4, -4, 1, 39, 39, f.main);
    v.blob(-2, 1, -3, 0, 40, 42, CREAM);
    v.box(1, 4, 5, 5, 32, 32, h.base);
    signal(v, f);
    v.box(-8, -8, 7, 7, 8, 17, '#3A2C28');
    v.box(-10, -6, 8, 8, 14, 18, '#E2CFA8');
    for (const [x, z] of [[-9, 16], [-8, 16], [-7, 16], [-7, 17], [-7, 15], [-6, 16]]) v.get(x, 8, z).l = INK;
  },

  // 冲浪手: long wavy hair, sunglasses pushed up, open shirt over a tee, surfboard and a wave
  RXQM(v, f, sk, h) {
    plinth(v, f, 'RXQM', (x, y) => ((y + 20 + Math.round(Math.sin(x * 0.8) * 1.3)) % 4 === 0 ? lite(f.light, 0.25) : null));
    const tee = '#F6F7FB';
    body(v, { main: f.main, legs: sk.base, shoe: '#5A3A28' });
    v.box(-5, -2, -3, 1, 10, 11, dark(f.main, 0.38)); v.box(1, 4, -3, 1, 10, 11, dark(f.main, 0.38));
    for (let z = 12; z <= 22; z++) for (let x = -2; x <= 1; x++) v.set(x, 2, z, tee);
    v.set(-1, 2, 22, sk.base); v.set(0, 2, 22, sk.base);
    for (const [x, z] of [[-4, 19], [3, 16], [-4, 14], [3, 20], [-3, 16]]) v.set(x, 2, z, lite(f.main, 0.45));
    v.set(-3, 3, 22, lite(f.main, 0.3)); v.set(2, 3, 22, lite(f.main, 0.3));
    arm(v, -1, 'down', { sleeve: f.main, skin: sk, bare: true });
    arm(v, 1, 'down', { sleeve: f.main, skin: sk, bare: true });
    for (let z = 8; z <= 33; z++) { const hw = z > 30 ? 1 : z > 27 || z < 9 ? 2 : 3; for (let x = -7 - hw; x <= -8 + hw; x++) v.set(x, 9, z, x === -8 || x === -7 || z === 22 ? f.main : CREAM); }
    v.box(4, 9, 5, 9, 8, 8, tee); v.box(5, 9, 6, 9, 9, 9, tee); v.box(7, 9, 7, 9, 10, 11, tee); v.box(8, 9, 6, 7, 12, 12, tee); v.set(6, 8, 10, tee);
    v.set(4, 9, 9, f.light, { a: 0.6 }); v.set(3, 8, 8, f.light, { a: 0.6 });
    head(v, sk);
    face(v, sk, { eyes: 'happy', brows: 'up', mouth: 'grin', browC: h.shade });
    hairShell(v, h, { layers: [[0, 4], [1, 3]], sideY: 2, sideZ: 19, backZ: 17, stripe: 0, locks: 24 });
    for (let z = 19; z <= 32; z++) { if (z % 4 < 2) v.box(8, 8, -6, -4, z, z, h.base); else v.box(8, 8, -1, 1, z, z, lite(h.base, 0.14)); }
    v.box(-5, -2, 1, 3, 37, 37, BLACK); v.box(1, 4, 1, 3, 37, 37, BLACK); v.set(-1, 2, 37, BLACK); v.set(0, 2, 37, BLACK);
    signal(v, f);
  },
};

export function voxelCard(code) {
  const p = PERSONAS.find((q) => q.code === code);
  if (!p || !build[code]) return null;
  const v = new Vox();
  build[code](v, FAM[p.fam], SKIN[p.skin], HAIR[p.hair], p);
  return renderVox(v, FAM[p.fam], `${p.title}，体素手办`, `v${code}`);
}

export default function voxelSet() {
  return PERSONAS.filter((p) => build[p.code]).map((p) => ({ code: p.code, svg: voxelCard(p.code) }));
}
