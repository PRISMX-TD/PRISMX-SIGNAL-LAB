// Style 6 (潮流海报), full set. One kit of shared parts, 16 personas composed from it.
// Flat colour, hard-edged shadow shapes (light from upper left), offset ink block shadow, big code type.
import { FAM, SKIN, HAIR, PERSONAS } from './personas.mjs';

const CREAM = '#F4F1EA';
const CHAR = '#2D3038', CHAR_D = '#1B1D24', CHAR_L = '#464B58';

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (v) => '#' + v.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = rgb(a), B = rgb(b); return hex(A.map((n, i) => n + (B[i] - n) * t)); };
const p = (d, fill, x = '') => `<path d="${d}" fill="${fill}"${x}/>`;
const ln = (d, stroke, w = 3, x = '') => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${x}/>`;
const circ = (cx, cy, r, fill, x = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${x}/>`;

// ------------------------------------------------------------------ shared geometry
const FACE = {
  A: 'M140 160 C138 122 164 98 204 98 C244 98 270 122 268 160 L266 204 C264 232 248 258 224 276 L206 286 L188 277 C162 258 146 232 143 204 Z',
  B: 'M142 160 C140 122 165 98 204 98 C243 98 268 122 266 160 L264 200 C262 230 246 256 226 272 C216 280 210 284 205 284 C200 284 194 280 184 272 C164 256 148 230 146 200 Z',
  C: 'M138 160 C136 122 163 98 204 98 C245 98 272 122 270 160 L270 210 C269 238 256 262 232 277 L206 289 L180 277 C156 262 143 238 142 210 Z',
  D: 'M141 160 C139 122 164 98 204 98 C244 98 269 122 267 160 L266 202 C264 234 250 258 228 273 C218 280 211 284 205 284 C199 284 192 280 182 273 C160 258 146 234 144 202 Z',
};
const EAR_L = 'M142 178 C130 172 124 190 131 204 C135 212 142 212 145 206 Z';
const EAR_R = 'M266 178 C278 172 284 190 277 204 C273 212 266 212 263 206 Z';
const NECK = {
  n: 'M176 248 L236 248 L238 306 L172 306 Z',
  slim: 'M182 248 L230 248 L232 306 L178 306 Z',
  wide: 'M166 246 L246 246 L250 306 L162 306 Z',
};
const JAW_SH = 'M176 250 C186 268 198 280 206 288 C216 282 230 268 236 250 L236 264 C228 282 216 294 206 300 C196 294 184 282 176 264 Z';
const SIDE_SH = 'M256 126 L244 166 L250 192 L234 214 L240 246 L216 272 L206 292 L320 292 L320 110 Z';
const STUBBLE = 'M146 214 C154 246 170 264 188 277 L206 286 L224 276 C242 264 258 246 264 214 L256 232 L240 246 L224 250 L206 247 L188 250 L172 246 L156 232 Z';
const TORSO = {
  n: 'M56 470 L74 352 C84 324 116 304 150 298 L170 292 L242 292 L262 298 C296 304 328 324 338 352 L356 470 Z',
  slim: 'M70 470 L86 358 C94 332 122 310 154 302 L174 294 L238 294 L258 302 C290 310 318 332 326 358 L342 470 Z',
  big: 'M38 470 L56 350 C68 320 108 300 148 294 L168 288 L244 288 L264 294 C304 300 344 320 356 350 L374 470 Z',
};
const SLEEK = 'M136 178 L132 142 L142 110 L168 88 L206 80 L246 86 L270 108 L280 142 L274 180 L268 150 L250 124 L224 110 L196 108 L168 118 L148 138 L140 158 Z';
const SLEEK_SH = 'M246 86 L270 108 L280 142 L274 180 L268 150 L250 124 L224 110 L234 94 Z';
const SLEEK_HI = 'M150 124 L170 100 L204 90 L180 104 L160 128 Z';
const SLEEK_CAST = 'M140 162 L148 140 L168 120 L196 110 L224 112 L250 126 L268 152 L268 164 L250 138 L224 124 L196 122 L170 132 L152 150 L142 168 Z';
const BEARD = {
  a: { d: 'M140 196 L141 206 C144 236 160 264 186 283 L206 293 L226 282 C250 264 266 236 268 206 L269 196 L258 214 L244 230 L226 236 L206 232 L186 236 L168 230 L154 214 Z',
       sh: 'M269 196 L268 206 C266 236 250 264 226 282 L206 293 L214 272 L230 262 L232 240 L244 230 L258 214 Z' },
  big: { d: 'M136 192 L138 212 C140 246 158 276 184 294 L206 306 L228 294 C254 276 272 246 274 212 L276 192 L264 214 L248 230 L228 236 L206 232 L184 236 L164 230 L148 214 Z',
         sh: 'M276 192 L274 212 C272 246 254 276 228 294 L206 306 L214 282 L232 268 L234 240 L248 230 L264 214 Z' },
};
const BEARD_HOLE = 'M188 247 Q206 241 224 247 Q206 265 188 247 Z';

// ------------------------------------------------------------------ face parts
const eyeOpen = (cx, ink, o = {}) => {
  const cy = o.y ?? 188, w = o.w ?? 15, h = o.h ?? 9, r = o.r ?? 5.5;
  const lashL = o.lash === 'L' ? `M${cx - w - 6} ${cy - 5} L${cx - w - 1} ${cy} ` : '';
  const lashR = o.lash === 'R' ? ' l5 -5' : '';
  return p(`M${cx - w} ${cy + 1} Q${cx} ${cy - h - 1} ${cx + w} ${cy} Q${cx} ${cy + h - 2} ${cx - w} ${cy + 1} Z`, '#FFFFFF') +
    circ(cx + (o.dx ?? 1), cy - 0.5, r, ink) +
    ln(`${lashL}M${cx - w - 1} ${cy} Q${cx} ${cy - h - 4} ${cx + w + 1} ${cy - 1}${lashR}`, ink, o.lash ? 3.4 : 3);
};
const eyeClosed = (cx, ink, y = 188) => ln(`M${cx - 13} ${y - 1} Q${cx} ${y + 7} ${cx + 13} ${y - 1}`, ink, 3.2);
const eyeHappy = (cx, ink, y = 188) => ln(`M${cx - 13} ${y + 3} Q${cx} ${y - 9} ${cx + 13} ${y + 3}`, ink, 3.4);
const EL = 172, ER = 238;

const BROW = {
  flat: [[150, 165, 194, 164], [214, 164, 258, 165]],
  raisedR: [[150, 166, 194, 165], [214, 160, 260, 152]],
  angry: [[150, 161, 194, 168], [214, 168, 258, 161]],
  worried: [[150, 169, 194, 160], [214, 160, 258, 169]],
  up: [[150, 161, 194, 158], [214, 158, 258, 161]],
  soft: [[152, 164, 192, 162], [216, 161, 256, 162]],
  fierce: [[151, 160, 193, 166], [215, 166, 257, 160]],
};
const brows = (type, col, t = 6, dy = 0) =>
  BROW[type].map(([x0, y0, x1, y1], i) => p(`M${x0} ${y0 + dy} L${x1} ${y1 + dy} L${x1 + 1} ${y1 + dy + t} L${x0 + 1} ${y0 + dy + t} Z`, i ? mix(col, '#000000', 0.18) : col)).join('');

const nose = (sk, type = 'std') =>
  type === 'small' ? p('M206 204 L215 230 L206 236 L201 231 Z', sk.shade) + ln('M197 235 Q206 240 216 233', sk.deep, 2.2)
  : type === 'broad' ? p('M206 196 L222 232 L206 240 L198 233 Z', sk.shade) + ln('M194 238 Q206 245 222 236', sk.deep, 2.4)
  : p('M206 196 L218 232 L206 238 L200 232 Z', sk.shade) + ln('M196 236 Q206 242 218 234', sk.deep, 2.4);

const MOUTH = {
  smirk: (sk) => ln('M188 256 Q206 262 226 250 l5 -4', sk.lip, 3.2) + p('M196 267 L216 263 L212 269 L200 271 Z', sk.shade),
  smile: (sk) => ln('M188 252 Q206 266 224 252', sk.lip, 3.2) + p('M198 268 L214 268 L210 273 L202 273 Z', sk.shade),
  soft: (sk) => ln('M192 255 Q206 262 220 255', sk.lip, 3.2),
  flat: (sk) => ln('M192 256 L221 255', sk.lip, 3.2) + p('M197 266 L215 265 L211 270 L201 270 Z', sk.shade),
  doubt: (sk) => ln('M192 258 Q208 259 224 251', sk.lip, 3.2) + p('M197 268 L215 266 L211 271 L201 272 Z', sk.shade),
  worry: (sk) => ln('M194 259 Q206 253 218 259', sk.lip, 3.2),
  grin: (sk) => p('M184 247 Q206 255 228 246 Q224 270 206 272 Q188 270 184 247 Z', mix(sk.lip, '#000000', 0.5)) + p('M188 250 Q206 256.5 224 249.5 L222 257 Q206 263 190 257 Z', '#FFFFFF'),
  lips: (sk) => p('M190 254 Q198 249 206 252.5 Q214 249 222 253 Q206 268 190 254 Z', sk.lip) + ln('M192 255 Q206 259 221 254', mix(sk.lip, '#000000', 0.4), 1.6),
  lipSmirk: (sk) => p('M190 256 Q198 251 206 254 Q216 249 228 249 Q212 268 190 256 Z', sk.lip) + ln('M192 256.5 Q208 259 227 250', mix(sk.lip, '#000000', 0.4), 1.6),
};

function head(K, o = {}) {
  const { id, sk } = K;
  return (o.ears === false ? '' : p(EAR_L, sk.base) + p(EAR_R, sk.shade)) + p(FACE[o.face || 'A'], sk.base) +
    `<g clip-path="url(#${id}face)">${p(SIDE_SH, sk.shade)}${o.cast ? p(o.cast, sk.shade) : ''}${o.shine ? p(o.shine, mix(sk.base, '#FFFFFF', 0.38)) : ''}${o.stubble ? p(STUBBLE, sk.deep, ' opacity=".42"') : ''}</g>` +
    nose(sk, o.nose);
}
const neck = (K, key = 'n') => p(NECK[key], K.sk.shade) + p(JAW_SH, K.sk.deep);
const torso = (K, key, g) => p(TORSO[key], g.light) + `<g clip-path="url(#${K.id}torso)">${p(TORSO[key], g.base, ' transform="translate(15 9)"')}${p('M214 296 L420 270 L420 480 L236 480 L224 380 Z', g.shade)}</g>`;
const hairSet = (K, base, sh, hi) => p(base, K.hair.base) + (sh ? p(sh, K.hair.shade) : '') + (hi ? p(hi, K.hair.hi) : '');

const signal = (K, cx = 124, cy = 194) =>
  [12, 23, 34].map((r, i) => {
    const a = (d) => [cx + r * Math.cos((d * Math.PI) / 180), cy + r * Math.sin((d * Math.PI) / 180)].map((n) => n.toFixed(1)).join(' ');
    return ln(`M${a(228)} A${r} ${r} 0 0 0 ${a(132)}`, K.f.light, 4.2, ` opacity="${[1, 0.82, 0.62][i]}"`);
  }).join('');
const earbud = (K, x = 127, y = 184) => `<rect x="${x}" y="${y}" width="12" height="21" rx="6" fill="${CREAM}"/>` + p(`M${x + 6} ${y} a6 6 0 0 1 6 6 v9 a6 6 0 0 1 -6 6 Z`, K.creamSh);

const FIST = 'M-22 -10 C-22 -20 -12 -25 0 -25 C14 -25 23 -19 23 -8 C23 6 18 16 14 24 L-16 24 C-20 14 -22 2 -22 -10 Z';
function fist(K, x, y, o = {}) {
  const { sk, ink } = K;
  return `<g transform="translate(${x} ${y}) rotate(${o.rot || 0}) scale(${o.s || 1})">` +
    (o.cuff ? p('M-20 20 L18 20 L26 86 L-30 86 Z', ink, ' transform="translate(7 7)"') + p('M-20 20 L18 20 L26 86 L-30 86 Z', o.cuff) : '') +
    p(FIST, ink, ' transform="translate(7 7)"') + (o.thumb ? p('M-7 -22 L-11 -58 C-11 -71 10 -71 10 -58 L12 -22 Z', ink, ' transform="translate(7 7)"') + p('M-7 -22 L-11 -58 C-11 -71 10 -71 10 -58 L12 -22 Z', sk.base) + p('M2 -67 C8 -66 10 -62 10 -58 L12 -22 L3 -22 Z', sk.shade) : '') +
    p(FIST, sk.base) + p('M8 -24 C18 -23 23 -17 23 -8 C23 6 18 16 14 24 L2 24 C8 12 10 -8 8 -24 Z', sk.shade) +
    ln('M-11 -19 v13 M-2 -21 v14 M7 -19 v13', sk.deep, 2) + '</g>';
}

const TH_BLOCK = 'M-20 -6 C-20 -14 -13 -18 -4 -18 L16 -18 C24 -18 28 -12 28 -4 L28 22 C28 30 22 34 14 34 L-10 34 C-18 34 -22 28 -22 20 Z';
const TH_THUMB = 'M-21 4 C-28 -16 -26 -38 -19 -50 C-14 -60 2 -58 2 -46 C2 -36 -1 -27 4 -16 L-4 6 Z';
const TH_CUFF = 'M-22 30 L28 30 L36 100 L-32 100 Z';
function thumbHand(K, x, y, o = {}) {
  const { sk, ink } = K, sh = ' transform="translate(7 7)"';
  return `<g transform="translate(${x} ${y}) rotate(${o.rot || 0}) scale(${o.s || 1})">` +
    (o.cuff ? p(TH_CUFF, ink, sh) + p(TH_CUFF, o.cuff) : '') +
    p(TH_THUMB, ink, sh) + p(TH_BLOCK, ink, sh) + p(TH_THUMB, sk.base) +
    p('M-9 -56 C-2 -58 2 -53 2 -46 C2 -36 -1 -27 4 -16 L-2 -10 C-7 -24 -6 -40 -9 -56 Z', sk.shade) +
    p(TH_BLOCK, sk.base) + p('M14 -18 L16 -18 C24 -18 28 -12 28 -4 L28 22 C28 30 22 34 14 34 L6 34 C12 20 14 0 14 -18 Z', sk.shade) +
    ln('M2 -5 H27 M1 8 H27 M2 21 H27', sk.deep, 2) + '</g>';
}

// ------------------------------------------------------------------ per-persona context
function ctx(per) {
  const f = FAM[per.fam], sk = SKIN[per.skin], h = HAIR[per.hair];
  const dark = per.hair === 'black' || per.hair === 'darkBrown';
  const dk1 = mix(f.dark, f.ink, 0.55), lt = mix(f.dark, f.main, 0.45);
  return {
    id: `p${per.code}`, per, f, sk, ink: f.ink,
    hair: { base: h.base, shade: h.shade, hi: mix(h.base, '#FFFFFF', dark ? 0.24 : 0.5) },
    creamSh: mix(CREAM, f.dark, 0.26), dk1, lt,
    G1: { base: dk1, shade: f.ink, light: lt },
    G2: { base: f.dark, shade: dk1, light: mix(f.dark, f.light, 0.34) },
    GC: { base: CREAM, shade: mix(CREAM, f.dark, 0.26), light: '#FFFFFF' },
  };
}

function compose(per, K, c) {
  const { id, f } = K;
  const band = mix(f.main, f.dark, 0.28), txt = mix(f.main, '#FFFFFF', 0.2);
  const sil = (c.sil || []).map((d) => (d.trim().startsWith('<') ? d : `<path d="${d}"/>`)).join('');
  return `<svg viewBox="0 0 400 460" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${per.title}，潮流海报画法">
<defs>
<pattern id="${id}dots" width="13" height="13" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><circle cx="3.5" cy="3.5" r="2.4" fill="${f.dark}"/></pattern>
<linearGradient id="${id}fade" x1="1" y1="1" x2=".2" y2=".2"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#000"/></linearGradient>
<mask id="${id}dm" maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="460"><rect width="400" height="460" fill="url(#${id}fade)"/></mask>
<clipPath id="${id}face"><path d="${FACE[c.face || 'A']}"/></clipPath>
<clipPath id="${id}torso"><path d="${TORSO[c.torso || 'n']}"/></clipPath>
${c.defs || ''}
</defs>
<rect width="400" height="460" fill="${f.main}"/>
<path d="M214 0 L400 0 L400 128 L156 460 L0 460 L0 318 Z" fill="${band}"/>
<rect width="400" height="460" fill="url(#${id}dots)" mask="url(#${id}dm)" opacity=".6"/>
<text x="12" y="152" textLength="376" lengthAdjust="spacingAndGlyphs" font-family="'Arial Black','Segoe UI Black','Arial',sans-serif" font-weight="900" font-size="132" fill="${txt}">${per.code}</text>
<g transform="translate(12 12)" fill="${f.ink}">${sil}</g>
${c.back || ''}
${c.body || ''}
${c.head || ''}
${c.front || ''}
</svg>`;
}

// ------------------------------------------------------------------ shared clothing bits
const rollneck = (a, b, c2, rib) =>
  p('M164 270 C186 284 226 284 248 270 L252 306 C226 320 186 320 160 306 Z', a) +
  p('M206 281 C222 280 238 276 248 270 L252 306 C238 313 222 317 206 318 Z', b) +
  p('M172 276 C190 290 222 290 240 276 L242 288 C222 300 190 300 170 288 Z', c2) +
  ln('M176 296 L174 312 M188 301 L187 316 M200 303 L200 318 M212 303 L213 318 M224 301 L226 316 M236 296 L239 311', rib, 2, ' opacity=".7"');
const shirtCollar = (a, b) => p('M176 292 L206 320 L188 338 L166 304 Z', a) + p('M236 292 L206 320 L224 338 L246 304 Z', b);
const crewLine = (col) => ln('M172 296 Q206 324 240 296', col, 4);

// ------------------------------------------------------------------ props
function pawn(K) {
  const { id, ink } = K;
  return `<g transform="translate(9 9)" fill="${ink}"><circle cx="78" cy="352" r="34"/><path d="M58 392 L98 392 L118 470 L38 470 Z"/><ellipse cx="78" cy="391" rx="31" ry="8.5"/></g>` +
    p('M58 392 L98 392 L118 470 L38 470 Z', CREAM) + p('M84 392 L98 392 L118 470 L92 470 Z', '#BFC6DB') +
    `<ellipse cx="78" cy="391" rx="31" ry="8.5" fill="${CREAM}"/>` + p('M78 399.5 A31 8.5 0 0 0 109 391 A31 8.5 0 0 0 96 385 L96 396 Z', '#BFC6DB') +
    circ(78, 352, 34, '#BFC6DB') + `<g clip-path="url(#${id}ball)">${circ(66, 342, 35, CREAM)}</g>` +
    `<ellipse cx="62" cy="336" rx="8" ry="5" fill="#fff" transform="rotate(-30 62 336)"/>`;
}

function wheel(K) {
  const { ink, creamSh, G1 } = K;
  const cx = 108, cy = 446, R = 90;
  const pt = (r, a) => `${(cx + r * Math.cos((a * Math.PI) / 180)).toFixed(1)} ${(cy + r * Math.sin((a * Math.PI) / 180)).toFixed(1)}`;
  const spoke = (a, col) => ln(`M${pt(14, a)} L${pt(R + 26, a)}`, col, 10);
  return p('M34 470 L38 398 L76 384 L94 470 Z', G1.base) + p('M126 470 L142 384 L178 398 L186 470 Z', G1.shade) +
    `<circle cx="${cx + 9}" cy="${cy + 9}" r="${R}" fill="none" stroke="${ink}" stroke-width="19"/>` +
    [-180, -135, -90, -45, 0].map((a) => `<path d="M${pt(R, a)} L${pt(R + 26, a)}" transform="translate(9 9)" fill="none" stroke="${ink}" stroke-width="10" stroke-linecap="round"/>`).join('') +
    spoke(-180, CREAM) + spoke(-135, CREAM) + spoke(-90, CREAM) + spoke(-45, creamSh) + spoke(0, creamSh) +
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${CREAM}" stroke-width="19"/>` +
    `<path d="M${pt(R, -50)} A${R} ${R} 0 0 1 ${pt(R, 30)}" fill="none" stroke="${creamSh}" stroke-width="19"/>` +
    circ(cx, cy, 22, CREAM) + circ(cx, cy, 9, K.f.dark) +
    fist(K, 57, 374, { s: 0.8, rot: -24 }) + fist(K, 160, 374, { s: 0.8, rot: 24 });
}

function pocketWatch(K) {
  const { ink, creamSh } = K;
  const cx = 82, cy = 394;
  const ticks = Array.from({ length: 12 }, (_, i) => { const a = (i * 30 * Math.PI) / 180; return `M${(cx + 29 * Math.cos(a)).toFixed(1)} ${(cy + 29 * Math.sin(a)).toFixed(1)} L${(cx + 34 * Math.cos(a)).toFixed(1)} ${(cy + 34 * Math.sin(a)).toFixed(1)}`; }).join(' ');
  return circ(cx + 9, cy + 9, 46, ink) + `<rect x="${cx - 7 + 9}" y="${cy - 60 + 9}" width="14" height="16" rx="3" fill="${ink}"/>` +
    ln(`M${cx + 8} ${cy - 66} C112 306 150 338 176 392`, CREAM, 4, ' stroke-dasharray="0.5 8.5"') +
    `<circle cx="${cx}" cy="${cy - 66}" r="8" fill="none" stroke="${CREAM}" stroke-width="4"/>` +
    `<rect x="${cx - 7}" y="${cy - 60}" width="14" height="16" rx="3" fill="${creamSh}"/>` +
    circ(cx, cy, 46, creamSh) + circ(cx, cy, 38, CREAM) + ln(ticks, ink, 2.6) +
    ln(`M${cx} ${cy} L${cx - 15} ${cy - 17}`, ink, 4.5) + ln(`M${cx} ${cy} L${cx + 20} ${cy - 13}`, ink, 3.2) + circ(cx, cy, 4.5, K.f.dark) +
    ln(`M${cx - 24} ${cy - 22} Q${cx - 16} ${cy - 32} ${cx - 2} ${cy - 34}`, '#FFFFFF', 3.5);
}

function rock(K) {
  const { ink, creamSh } = K;
  const out = 'M22 470 L30 396 L58 352 L106 340 L140 366 L152 420 L148 470 Z';
  return p(out, ink, ' transform="translate(9 9)"') + p(out, CREAM) +
    p('M58 352 L106 340 L98 372 L62 384 Z', '#FFFFFF') +
    p('M62 384 L98 372 L112 420 L82 470 L22 470 L50 430 Z', creamSh) +
    p('M106 340 L140 366 L152 420 L148 470 L82 470 L112 420 L98 372 Z', mix(CREAM, ink, 0.45)) +
    ln('M50 430 L62 384', mix(CREAM, ink, 0.3), 2);
}

function knife(K) {
  const { ink, creamSh } = K;
  const blade = 'M72 396 L70 282 C72 262 86 246 102 238 L104 396 Z';
  return p(blade, ink, ' transform="translate(9 9)"') + p(blade, CREAM) + p('M93 250 L102 238 L104 396 L93 396 Z', creamSh) +
    p('M64 392 L112 392 L112 402 L64 402 Z', K.f.light) + p('M78 400 L100 400 L102 452 L76 452 Z', CHAR_D) +
    fist(K, 90, 428, { s: 0.92 });
}

// boxing glove seen from the front; thumb: 'R' or 'L' = which side the thumb sits on
function glove(K, x, y, o = {}) {
  const { ink, creamSh, f, dk1 } = K;
  const m = o.thumb === 'L' ? -1 : 1, tf = `rotate(${o.rot || 0}) scale(${o.s || 1})`;
  const MITT = 'M-48 -6 C-52 -44 -30 -68 2 -68 C36 -68 54 -44 52 -8 C50 16 42 32 34 46 L-32 46 C-42 30 -46 14 -48 -6 Z';
  const TH = `M${m * 34} -16 C${m * 56} -26 ${m * 74} -8 ${m * 72} 14 C${m * 70} 34 ${m * 54} 46 ${m * 30} 46 Z`;
  const CUFF = 'M-34 42 L36 42 L44 112 L-42 112 Z';
  const base = f.dark, hi = mix(f.dark, f.light, 0.36);
  return `<g transform="translate(${x} ${y})">` +
    `<g transform="translate(9 9) ${tf}" fill="${ink}"><path d="${CUFF}"/><path d="${TH}"/><path d="${MITT}"/></g>` +
    `<g transform="${tf}">` +
    p(CUFF, CREAM) + p('M12 42 L36 42 L44 112 L20 112 Z', creamSh) + ln('M-36 60 L38 60', f.dark, 4.5) + ln('M-38 76 L40 76', f.dark, 4.5) +
    p(TH, m > 0 ? mix(dk1, ink, 0.35) : mix(base, hi, 0.45)) +
    p(MITT, base) + p('M14 -67 C40 -62 54 -42 52 -8 C50 16 42 32 34 46 L10 46 C24 22 30 -24 14 -67 Z', dk1) +
    p('M-37 -22 C-35 -44 -21 -58 -5 -60 C-19 -50 -29 -40 -31 -20 Z', hi) +
    ln('M-45 16 C-20 30 20 30 48 14', mix(dk1, ink, 0.3), 2.6) +
    '</g></g>';
}

function clipboard(K) {
  const { ink, creamSh, sk } = K;
  const chk = [370, 398, 426].map((y) => ln(`M60 ${y} l6 6 l11 -12`, K.f.dark, 4.5) + ln(`M88 ${y} H${y === 398 ? 120 : 127}`, mix(CREAM, ink, 0.3), 5)).join('');
  return `<g transform="rotate(-7 96 400)"><rect x="50" y="339" width="106" height="140" rx="10" fill="${ink}"/><rect x="41" y="330" width="106" height="140" rx="10" fill="${CHAR}"/>` +
    `<rect x="50" y="346" width="88" height="120" rx="3" fill="${CREAM}"/><rect x="120" y="346" width="18" height="120" fill="${creamSh}"/>` + chk +
    `<rect x="76" y="320" width="36" height="19" rx="5" fill="${creamSh}"/><rect x="88" y="325" width="12" height="6" rx="2" fill="${CHAR}"/></g>` +
    p('M140 392 C154 388 164 396 164 408 C164 420 154 426 142 424 Z', ink, ' transform="translate(6 6)"') + p('M140 392 C154 388 164 396 164 408 C164 420 154 426 142 424 Z', sk.base) + p('M152 392 C160 394 164 400 164 408 C164 418 158 424 150 425 Z', sk.shade);
}

function wrench(K) {
  const { ink, creamSh } = K;
  const d = 'M56 270 L70 244 L80 270 L92 270 L102 244 L116 270 L110 298 L98 308 L98 452 L74 452 L74 308 L62 298 Z';
  return p(d, ink, ' transform="translate(9 9)"') + p(d, CREAM) + p('M92 270 L102 244 L116 270 L110 298 L98 308 L98 452 L88 452 L88 270 Z', creamSh) +
    fist(K, 86, 424, { s: 0.92 });
}

function stopwatch(K) {
  const { ink, creamSh, f } = K;
  const cx = 82, cy = 398, body = mix(f.ink, f.dark, 0.25);
  const ticks = Array.from({ length: 12 }, (_, i) => { const a = (i * 30 * Math.PI) / 180; return `M${(cx + 27 * Math.cos(a)).toFixed(1)} ${(cy + 27 * Math.sin(a)).toFixed(1)} L${(cx + 32 * Math.cos(a)).toFixed(1)} ${(cy + 32 * Math.sin(a)).toFixed(1)}`; }).join(' ');
  return circ(cx + 9, cy + 9, 46, ink) +
    `<rect x="${cx - 8}" y="${cy - 64}" width="16" height="22" rx="4" fill="${body}"/>` +
    `<rect x="${cx - 6}" y="${cy - 62}" width="12" height="18" rx="3" fill="${body}" transform="rotate(38 ${cx} ${cy})"/>` +
    `<rect x="${cx - 6}" y="${cy - 62}" width="12" height="18" rx="3" fill="${body}" transform="rotate(-38 ${cx} ${cy})"/>` +
    circ(cx, cy, 46, body) + circ(cx, cy, 37, CREAM) + p(`M${cx} ${cy + 37} A37 37 0 0 0 ${cx + 37} ${cy} A37 37 0 0 0 ${cx + 30} ${cy - 21.6} L${cx + 14} ${cy + 22} Z`, creamSh) +
    ln(ticks, ink, 2.6) + ln(`M${cx} ${cy + 8} L${cx} ${cy - 24}`, f.dark, 4.5) + circ(cx, cy, 5, ink) +
    `<circle cx="${cx}" cy="${cy + 15}" r="7" fill="none" stroke="${ink}" stroke-width="2"/>`;
}

function magnifier(K) {
  const { ink, f } = K;
  const cx = 76, cy = 370;
  return `<circle cx="${cx + 9}" cy="${cy + 9}" r="38" fill="none" stroke="${ink}" stroke-width="9"/>` +
    `<path d="M112 406 L146 440" transform="translate(9 9)" fill="none" stroke="${ink}" stroke-width="13" stroke-linecap="round"/>` +
    circ(cx, cy, 36, mix(f.light, '#FFFFFF', 0.4), ' opacity=".92"') + ln(`M${cx - 20} ${cy - 14} Q${cx - 13} ${cy - 25} ${cx} ${cy - 28}`, '#FFFFFF', 4.5) +
    `<circle cx="${cx}" cy="${cy}" r="38" fill="none" stroke="${ink}" stroke-width="9"/>` +
    `<circle cx="${cx}" cy="${cy}" r="38" fill="none" stroke="${mix(ink, f.light, 0.3)}" stroke-width="3" stroke-dasharray="70 400" transform="rotate(-150 ${cx} ${cy})"/>` +
    ln('M106 400 L146 440', ink, 13) + fist(K, 146, 440, { s: 0.86, rot: -30 });
}

function coin(K) {
  const { ink, creamSh, f } = K;
  return `<g transform="rotate(-22 94 334)"><ellipse cx="103" cy="345" rx="30" ry="24" fill="${ink}"/><ellipse cx="96" cy="339" rx="30" ry="24" fill="${creamSh}"/><ellipse cx="94" cy="334" rx="30" ry="24" fill="${CREAM}"/>` +
    `<ellipse cx="94" cy="334" rx="21" ry="16" fill="none" stroke="${creamSh}" stroke-width="2.5"/><path d="M94 322 L104 334 L94 346 L84 334 Z" fill="${f.dark}"/></g>` +
    ln('M58 392 Q48 370 60 352', CREAM, 3.5) + ln('M126 388 Q140 366 130 346', CREAM, 3.5) +
    thumbHand(K, 86, 420, { s: 0.92, rot: 8, cuff: K.G2.base });
}

function paperPlane(K) {
  const { ink, creamSh } = K;
  return p('M28 366 L140 318 L94 424 L70 398 Z', ink, ' transform="translate(8 8)"') +
    p('M28 366 L140 318 L78 388 Z', CREAM) + p('M140 318 L78 388 L94 424 Z', creamSh) + p('M78 388 L94 424 L70 398 Z', mix(creamSh, ink, 0.3)) +
    ln('M30 424 L56 412', CREAM, 3.5) + ln('M22 448 L50 436', CREAM, 3.5);
}

function thumbsUp(K) { return thumbHand(K, 90, 398, { s: 1.2, rot: -14, cuff: K.G2.base }); }

function wave(K) {
  const { ink, creamSh } = K;
  const d = 'M-12 470 L-12 404 C20 380 52 366 80 372 C104 378 120 392 118 408 C112 398 100 394 90 398 C102 404 106 418 98 428 C112 446 138 458 166 470 Z';
  const outer = 'M-12 470 L-12 404 C20 380 52 366 80 372 C104 378 120 392 118 408 C116 430 140 456 166 470 Z';
  return p(outer, ink, ' transform="translate(9 8)"') + p(outer, creamSh) + p(d, CREAM) + ln('M8 428 C28 404 52 396 72 400', creamSh, 3.5) + ln('M12 452 C32 436 54 430 74 436', creamSh, 3.5) +
    circ(132, 380, 5, CREAM) + circ(144, 400, 3.5, CREAM) + circ(122, 358, 3, CREAM);
}

// ------------------------------------------------------------------ the 16 personas
const BUILD = {
  AGLZ(K) {
    const { id, sk, ink } = K;
    const H = 'M134 178 L128 142 L140 108 L166 84 L206 74 L248 82 L272 106 L282 142 L274 180 L268 152 L252 128 L228 116 L202 124 L178 114 L152 130 L140 154 Z';
    return {
      face: 'A', sil: [H, FACE.A, TORSO.n],
      defs: `<clipPath id="${id}lens"><rect x="148" y="170" width="48" height="32" rx="9"/></clipPath><clipPath id="${id}ball"><circle cx="78" cy="352" r="34"/></clipPath>`,
      body: p(TORSO.n, '#22316E') + p('M214 300 L262 298 C296 304 328 324 338 352 L356 470 L236 470 L224 380 Z', '#151F4B') +
        p('M74 352 C84 324 116 304 150 298 L146 310 C120 316 98 332 90 356 L74 444 L60 444 Z', '#3D5ECF') +
        p('M170 292 L242 292 L214 398 L206 406 L198 398 Z', '#AFC3FC') + p('M206 300 L242 292 L214 398 L206 406 Z', '#7D9BEF') +
        p('M170 292 L148 299 L152 350 L204 420 L198 398 Z', '#3D5ECF') + p('M242 292 L264 299 L260 350 L208 420 L214 398 Z', '#1B2860') +
        neck(K) + rollneck('#AFC3FC', '#7D9BEF', '#5C7EDC', '#3D5ECF'),
      head: head(K, { cast: 'M142 162 L140 154 L152 130 L178 114 L202 124 L228 116 L252 128 L268 152 L268 162 L250 140 L228 129 L202 137 L178 127 L156 141 Z' }) +
        MOUTH.smirk(sk) +
        p('M148 163 L194 160 L195 166 L149 169 Z', '#8E96AD') + p('M214 158 L260 151 L262 157 L215 165 Z', '#7B839B') +
        `<rect x="148" y="170" width="48" height="32" rx="9" fill="#FFFFFF"/><g clip-path="url(#${id}lens)"><path d="M140 206 L172 166 L184 166 L152 206 Z M166 206 L198 166 L204 166 L172 206 Z" fill="#B3C7FF"/></g>` +
        `<rect x="214" y="170" width="48" height="32" rx="9" fill="#B3C7FF" opacity=".35"/>` +
        p('M222 188 Q238 177 254 187 Q238 196 222 188 Z', '#fff') + circ(239, 186.5, 5.6, ink) + ln('M221 187 Q238 174 255 186', ink, 3) +
        `<g fill="none" stroke="${ink}" stroke-width="3.6" stroke-linecap="round"><rect x="148" y="170" width="48" height="32" rx="9"/><rect x="214" y="170" width="48" height="32" rx="9"/><path d="M196 184 Q205 178 214 184 M148 182 L138 178 M262 182 L270 178"/></g>` +
        p(H, '#E6EAF3') + p('M248 82 L272 106 L282 142 L274 180 L268 152 L252 128 L228 116 L236 98 Z', '#AEB5CA') +
        p('M140 154 L152 130 L178 114 L202 124 L228 116 L252 128 L268 152 L264 138 L250 121 L228 108 L202 116 L178 106 L154 120 L142 142 Z', '#C8CEDF') +
        p('M146 122 L168 96 L204 84 L180 100 L158 130 Z M214 84 L240 91 L224 96 Z', '#FFFFFF') +
        ln('M202 116 L212 90 M178 106 L188 88 M228 108 L238 94', '#AEB5CA', 2.2),
      front: pawn(K),
    };
  },

  AGLM(K) {
    const { sk, ink, hair, G1, creamSh, f } = K;
    const CROWN = 'M124 134 C116 94 158 64 206 64 C254 64 296 94 288 134 L280 146 L132 146 Z';
    const VISOR = 'M128 154 L284 154 C278 166 252 169 206 169 C160 169 134 166 128 154 Z';
    return {
      face: 'A', sil: [CROWN, VISOR, FACE.A, BEARD.a.d, TORSO.n],
      body: torso(K, 'n', G1) + p('M176 298 L236 298 L206 354 Z', CREAM) + p('M206 298 L236 298 L206 354 Z', creamSh) +
        neck(K) + rollneck(CREAM, creamSh, mix(creamSh, ink, 0.22), mix(creamSh, ink, 0.3)) +
        p('M170 294 L142 304 L136 350 L198 410 L210 384 L196 336 Z', K.lt) + p('M242 294 L270 304 L276 350 L222 400 L210 384 L224 336 Z', mix(G1.base, G1.shade, 0.55)) +
        ln('M210 386 L205 470', ink, 3) + circ(176, 428, 6.5, CREAM) + circ(176, 458, 6.5, CREAM) + circ(240, 424, 6.5, creamSh) + circ(240, 454, 6.5, creamSh),
      head: head(K, { cast: 'M138 168 L270 168 L270 180 L138 180 Z' }) +
        p(`${BEARD.a.d} ${BEARD_HOLE}`, hair.base, ' fill-rule="evenodd"') + p(BEARD.a.sh, hair.shade) + ln('M194 252 L219 252', sk.lip, 3) +
        eyeOpen(EL, ink, { y: 192, h: 7 }) + eyeOpen(ER, ink, { y: 192, h: 7 }) + brows('angry', hair.shade, 6, 10) +
        p('M135 184 L133 156 L147 156 L145 176 Z', hair.base) + p('M273 186 L275 156 L261 156 L263 176 Z', hair.shade) +
        p(CROWN, CREAM) + p('M236 66 C272 72 296 98 288 134 L280 146 L226 146 L242 108 Z', creamSh) +
        p('M132 142 L280 142 L278 158 L134 158 Z', ink) + p('M196 142 L216 142 L214 154 L206 159 L198 154 Z', f.light) +
        p('M206 96 L218 110 L206 124 L194 110 Z', f.dark) + p(VISOR, mix(ink, '#000000', 0.3)) + p('M134 156 L206 156 L206 160 L140 162 Z', mix(ink, f.main, 0.3)),
      front: wheel(K),
    };
  },

  AGQZ(K) {
    const { sk, ink, hair, creamSh, f, GC } = K;
    const BACK = 'M124 204 C116 128 150 74 206 74 C262 74 296 128 288 204 L290 246 C284 262 266 266 252 260 L160 260 C146 266 128 262 122 246 Z';
    const FRINGE = 'M132 182 L128 140 L142 104 L170 82 L208 74 L250 82 L276 108 L284 144 L278 184 L270 150 L252 124 L236 114 L216 138 L186 152 L156 156 L140 168 Z';
    const apron = f.dark, apSh = mix(f.dark, f.ink, 0.5);
    return {
      face: 'B', torso: 'slim', sil: [BACK, FRINGE, FACE.B, TORSO.slim],
      back: p(BACK, hair.base) + p('M250 84 C282 102 294 150 288 204 L290 246 C284 262 266 266 252 260 L250 200 Z', hair.shade),
      body: torso(K, 'slim', GC) + neck(K, 'slim') + shirtCollar('#FFFFFF', creamSh) +
        p('M160 354 L176 298 L186 301 L172 356 Z', apron) + p('M252 354 L236 298 L226 301 L240 356 Z', apSh) +
        p('M156 352 L256 352 L264 470 L148 470 Z', apron) + p('M224 352 L256 352 L264 470 L232 470 Z', apSh) + p('M156 352 L256 352 L257 361 L155 361 Z', K.lt) +
        p('M182 398 L230 398 L228 436 L184 436 Z', mix(apron, f.light, 0.22)) + ln('M194 398 L194 386 M204 398 L204 382', creamSh, 3.5),
      head: head(K, { face: 'B', ears: false, nose: 'small', cast: 'M140 174 L156 162 L186 158 L216 144 L236 120 L252 130 L270 156 L270 168 L250 140 L238 132 L220 154 L188 168 L158 172 L142 182 Z' }) +
        ln('M191 253 Q206 265 223 252', sk.lip, 3.2) + brows('soft', hair.shade, 4.5) + eyeOpen(ER, ink, { lash: 'R', h: 10 }) +
        ln('M158 176 C150 150 160 128 180 116', ink, 2.6) + circ(EL, 189, 20, ink) + circ(EL, 189, 14, mix(f.light, '#FFFFFF', 0.35)) +
        ln('M163 184 Q166 177 174 175', '#FFFFFF', 3) + `<circle cx="${EL}" cy="189" r="17" fill="none" stroke="${mix(ink, f.light, 0.35)}" stroke-width="2"/>` +
        hairSet(K, FRINGE, 'M250 82 L276 108 L284 144 L278 184 L270 150 L252 124 L236 114 L240 96 Z', 'M150 118 L172 94 L206 84 L184 100 L164 126 Z') +
        p('M131 178 L140 164 L147 204 L150 240 L142 258 L128 248 L125 204 Z', hair.base) + p('M279 180 L270 164 L263 204 L260 240 L268 258 L282 248 L285 204 Z', hair.shade),
      front: pocketWatch(K),
    };
  },

  AGQM(K) {
    const { sk, ink, hair, creamSh, f, GC, G1 } = K;
    const H = 'M134 178 L130 142 L138 114 L150 120 L158 92 L174 104 L188 76 L204 96 L222 72 L234 96 L254 82 L258 108 L278 108 L272 136 L282 150 L274 180 L268 152 L140 152 Z';
    const band = f.light, bandSh = mix(f.light, f.dark, 0.38);
    return {
      face: 'D', sil: [H, FACE.D, TORSO.n, 'M272 146 L294 130 L302 146 L282 158 L300 162 L296 180 L274 168 Z'],
      body: torso(K, 'n', GC) + neck(K) + crewLine(creamSh) +
        p('M112 314 C124 306 138 300 150 298 L170 292 L188 470 L96 470 L104 380 Z', G1.base) + p('M112 314 C124 306 138 300 150 298 L152 307 C140 309 128 315 120 321 L107 400 L104 380 Z', K.lt) +
        p('M300 314 C288 306 274 300 262 298 L242 292 L224 470 L316 470 L308 380 Z', G1.shade) +
        p('M118 400 L164 400 L166 442 L116 442 Z', mix(G1.base, K.lt, 0.35)) + ln('M118 410 L164 410', G1.shade, 2.5) +
        ln('M176 298 L188 384', ink, 4) + ln('M236 298 L224 384', ink, 4) +
        p('M170 382 L204 382 L206 432 L166 432 Z', CHAR) + p('M208 382 L242 382 L246 432 L206 432 Z', CHAR_D) + p('M196 390 L216 390 L216 404 L196 404 Z', CHAR_L) +
        `<ellipse cx="186" cy="432" rx="20" ry="7.5" fill="${f.light}"/><ellipse cx="226" cy="432" rx="20" ry="7.5" fill="${bandSh}"/>` +
        `<rect x="174" y="374" width="24" height="10" rx="3" fill="${CHAR_L}"/><rect x="214" y="374" width="24" height="10" rx="3" fill="${CHAR}"/>`,
      head: head(K, { face: 'D', cast: 'M138 168 L273 162 L273 172 L138 178 Z' }) + MOUTH.smirk(sk) +
        eyeOpen(EL, ink) + eyeOpen(ER, ink) + brows('raisedR', hair.shade, 6.5, 6) +
        hairSet(K, H, 'M234 96 L254 82 L258 108 L278 108 L272 136 L282 150 L274 180 L268 152 L240 152 Z', 'M150 130 L160 100 L170 112 L163 134 Z M186 112 L190 86 L200 102 L196 120 Z') +
        p('M272 146 L294 130 L302 146 L282 158 Z', band) + p('M276 156 L300 162 L296 180 L274 168 Z', bandSh) +
        p('M136 150 L272 144 L273 162 L138 168 Z', band) + p('M232 146 L272 144 L273 162 L236 164 Z', bandSh),
    };
  },

  AXLZ(K) {
    const { sk, ink, hair, f, G1 } = K;
    const armA = 'M334 368 L352 432 L150 456 L138 412 Z', armB = 'M62 382 L46 448 L262 434 L272 384 Z';
    return {
      face: 'C', torso: 'big', sil: [FACE.C, BEARD.big.d, TORSO.big, EAR_L, EAR_R],
      body: torso(K, 'big', G1) + neck(K, 'wide') +
        p('M164 288 C184 306 228 306 248 288 L254 300 C230 322 182 322 158 300 Z', f.dark) + p('M206 302 C222 302 238 296 248 288 L254 300 C240 312 224 318 206 318 Z', mix(f.dark, ink, 0.4)) +
        ln('M172 298 L170 308 M186 304 L185 315 M200 306 L200 318 M214 306 L215 317 M228 303 L230 313 M242 296 L245 306', ink, 2, ' opacity=".6"') +
        p(armA, G1.shade) + p(armB, ink, ' transform="translate(0 9)"') + p(armB, G1.base) + p('M62 382 L272 384 L270 394 L59 394 Z', f.dark) +
        p('M262 380 C284 378 298 390 298 406 C298 422 284 434 262 436 Z', sk.base) + p('M280 384 C292 390 298 398 298 406 C298 420 288 430 274 434 Z', sk.shade) + ln('M270 394 h18 M270 407 h20 M270 420 h16', sk.deep, 2),
      head: head(K, { face: 'C', nose: 'broad', shine: 'M156 126 L176 108 L206 102 L184 114 L166 134 Z' }) +
        p(`${BEARD.big.d} ${BEARD_HOLE}`, hair.base, ' fill-rule="evenodd"') + p(BEARD.big.sh, hair.shade) + ln('M194 252 L219 252', sk.lip, 3) +
        eyeClosed(EL, ink) + eyeClosed(ER, ink) + brows('flat', hair.base, 8),
      front: rock(K),
    };
  },

  AXLM(K) {
    const { sk, ink, hair, creamSh, f, G1 } = K;
    const TAIL = 'M232 86 C256 58 296 66 306 104 C314 140 300 190 312 252 C294 240 282 204 284 164 C284 134 272 110 250 98 Z';
    const ARM = 'M40 470 L58 384 C70 340 96 290 112 252 L150 268 C140 310 124 370 118 470 Z';
    return {
      face: 'B', torso: 'slim', sil: [TAIL, SLEEK, FACE.B, TORSO.slim, ARM],
      back: p(TAIL, hair.base) + p('M272 80 C292 86 304 100 306 124 C306 160 300 200 312 252 C298 228 296 180 296 140 C296 112 286 94 272 80 Z', hair.shade) + p('M230 92 L246 76 L256 86 L240 102 Z', f.light),
      body: torso(K, 'slim', G1) + p('M174 294 L238 294 L212 396 L206 402 L200 396 Z', '#FFFFFF') + p('M206 300 L238 294 L212 396 L206 402 Z', creamSh) +
        neck(K, 'slim') + shirtCollar('#FFFFFF', creamSh) +
        p('M166 300 L150 306 L156 356 L204 420 L198 396 Z', K.lt) + p('M246 300 L262 306 L256 356 L208 420 L214 396 Z', mix(G1.base, G1.shade, 0.6)),
      head: head(K, { face: 'B', nose: 'small', cast: SLEEK_CAST }) + MOUTH.lipSmirk(sk) +
        eyeOpen(EL, ink, { lash: 'L' }) + eyeOpen(ER, ink, { lash: 'R' }) + brows('raisedR', hair.shade, 4.6) +
        hairSet(K, SLEEK, SLEEK_SH, SLEEK_HI) + circ(274, 216, 5.5, mix(f.light, f.dark, 0.25)),
      front: p(ARM, G1.base) + p('M40 470 L58 384 C70 340 96 290 112 252 L123 257 C107 296 82 344 70 388 L55 470 Z', K.lt) + p('M107 264 L112 252 L150 268 L146 281 Z', '#FFFFFF') +
        p('M100 206 C98 194 104 188 114 190 L118 256 L106 254 C101 240 101 222 100 206 Z', sk.shade) +
        p('M118 136 L148 140 L140 254 L110 250 Z', CREAM) + p('M140 139 L148 140 L140 254 L132 253 Z', creamSh) + circ(128, 153, 5, ink) +
        `<g transform="rotate(4 120 220)"><rect x="101" y="194" width="36" height="14" rx="7" fill="${sk.base}"/><rect x="100" y="210" width="38" height="14" rx="7" fill="${sk.base}"/><rect x="101" y="226" width="36" height="14" rx="7" fill="${sk.base}"/><rect x="104" y="242" width="30" height="13" rx="6.5" fill="${sk.shade}"/></g>`,
    };
  },

  AXQZ(K) {
    const { sk, ink, hair, creamSh, f } = K;
    const KNOT = 'M186 82 L184 56 L196 42 L214 40 L228 50 L230 72 L222 84 Z';
    const g = { base: CHAR, shade: CHAR_D, light: CHAR_L };
    return {
      face: 'A', sil: [KNOT, SLEEK, FACE.A, TORSO.n],
      body: torso(K, 'n', g) + p('M184 290 L228 290 L206 338 Z', CREAM) + p('M206 290 L228 290 L206 338 Z', creamSh) + neck(K) +
        p('M244 290 L228 290 L202 342 L212 358 Z', mix(f.light, f.dark, 0.4)) + p('M168 290 L184 290 L250 414 L236 424 Z', f.light) +
        ln('M243 420 L250 470', CHAR_D, 3),
      head: head(K, { cast: SLEEK_CAST }) + MOUTH.smirk(sk) +
        eyeOpen(EL, ink, { h: 7, w: 16 }) + eyeOpen(ER, ink, { h: 7, w: 16 }) + brows('angry', hair.shade, 6.5) +
        p(KNOT, hair.base) + p('M214 40 L228 50 L230 72 L222 84 L210 83 L216 60 Z', hair.shade) + p('M190 62 L198 48 L206 46 L196 60 Z', hair.hi) +
        hairSet(K, SLEEK, SLEEK_SH, SLEEK_HI) + p('M190 78 L226 76 L227 85 L191 87 Z', f.light) +
        p('M138 178 L140 158 L147 160 L146 198 L141 202 Z', hair.base) + p('M270 180 L268 158 L261 160 L262 198 L267 202 Z', hair.shade),
      front: knife(K),
    };
  },

  // boxer: short crop with faded sides, tape across the nose, slit brow, cream tank with a bolt,
  // gloves up (the near one thrown at the viewer)
  AXQM(K) {
    const { sk, ink, hair, creamSh, f } = K;
    const skinG = { base: sk.base, shade: sk.shade, light: mix(sk.base, '#FFFFFF', 0.24) };
    const H = 'M140 152 L137 120 L146 96 L166 78 L196 64 L232 66 L258 80 L271 106 L271 152 L263 132 L246 120 L226 125 L208 112 L188 124 L170 118 L152 132 Z';
    const TANK = 'M160 298 L178 292 C184 330 228 330 234 292 L252 298 C256 324 268 344 286 356 C278 396 280 436 286 470 L126 470 C132 436 134 396 126 356 C144 344 156 324 160 298 Z';
    const BOLT = 'M200 352 L224 352 L212 386 L229 386 L192 440 L203 400 L187 400 Z';
    const tape = '#FFF6E6';
    return {
      face: 'D', sil: [H, FACE.D, TORSO.n],
      body: torso(K, 'n', skinG) + neck(K) +
        p(TANK, CREAM) + p('M206 320 C220 318 232 308 234 292 L252 298 C256 324 268 344 286 356 C278 396 280 436 286 470 L214 470 Z', creamSh) +
        ln('M178 292 C184 330 228 330 234 292', f.dark, 4.5) + ln('M160 298 C156 324 144 344 126 356', f.dark, 4) + ln('M252 298 C256 324 268 344 286 356', mix(f.dark, ink, 0.4), 4) +
        p(BOLT, f.dark) + p('M212 386 L229 386 L192 440 L203 400 L208 400 Z', mix(f.dark, ink, 0.4)),
      head: head(K, { face: 'D', nose: 'broad', cast: 'M140 162 L152 142 L170 128 L188 134 L208 122 L226 135 L246 130 L263 142 L271 162 L271 172 L263 152 L246 140 L226 145 L208 132 L188 144 L170 138 L152 152 L142 170 Z' }) +
        MOUTH.grin(sk) + eyeOpen(EL, ink, { h: 8 }) + eyeOpen(ER, ink, { h: 8 }) + brows('fierce', hair.base, 7.5) +
        ln('M171 155 L166 172', sk.base, 3.6) +
        `<g transform="rotate(-6 206 208)"><rect x="186" y="201" width="40" height="14" rx="7" fill="${ink}" opacity=".28" transform="translate(2 3)"/><rect x="186" y="201" width="40" height="14" rx="7" fill="${tape}"/><rect x="199" y="201" width="14" height="14" fill="${mix(tape, sk.shade, 0.3)}"/></g>` +
        p('M139 188 L137 150 L147 136 L148 174 Z', hair.base, ' opacity=".55"') + p('M270 190 L272 150 L263 136 L262 174 Z', hair.shade, ' opacity=".6"') +
        hairSet(K, H, 'M232 66 L258 80 L271 106 L271 152 L263 132 L246 120 L238 94 Z', null) +
        ln('M156 112 L170 92 M176 100 L192 80 M200 92 L214 76', hair.hi, 2.8, ' opacity=".85"'),
      front: ln('M26 286 l18 15 M12 314 l16 11', CREAM, 3.5) +
        glove(K, 90, 384, { s: 1.12, rot: -8, thumb: 'R' }) + glove(K, 326, 408, { s: 0.92, rot: 9, thumb: 'L' }),
    };
  },

  RGLZ(K) {
    const { sk, ink, hair, creamSh, f } = K;
    const BUN = 'M246 228 L254 216 L270 214 L284 224 L286 244 L276 258 L258 260 L246 248 Z';
    const H = 'M136 180 L132 142 L142 108 L168 86 L206 78 L246 84 L270 106 L280 142 L274 182 L266 148 L246 124 L222 112 L206 104 L190 112 L166 124 L146 148 Z';
    const g = { base: '#343843', shade: '#20232B', light: '#4D5262' };
    return {
      face: 'B', torso: 'slim', sil: [BUN, H, FACE.B, TORSO.slim],
      back: p(BUN, hair.base) + p('M270 214 L284 224 L286 244 L276 258 L266 259 L272 236 Z', hair.shade),
      body: torso(K, 'slim', g) + p('M174 294 L238 294 L212 396 L206 402 L200 396 Z', '#FFFFFF') + p('M206 300 L238 294 L212 396 L206 402 Z', creamSh) +
        neck(K, 'slim') + shirtCollar('#FFFFFF', creamSh) +
        p('M201 332 L211 332 L217 390 L206 404 L195 390 Z', f.dark) + p('M206 332 L211 332 L217 390 L206 404 Z', mix(f.dark, ink, 0.4)) + p('M197 318 L215 318 L211 333 L201 333 Z', mix(f.dark, ink, 0.5)) +
        p('M166 300 L150 306 L156 352 L200 416 L196 390 L186 344 Z', g.light) + p('M246 300 L262 306 L256 352 L212 416 L216 390 L226 344 Z', '#2A2D36'),
      head: head(K, { face: 'B', nose: 'small', cast: 'M146 154 L166 130 L190 118 L206 110 L222 118 L246 130 L266 154 L268 166 L246 140 L222 128 L206 120 L190 128 L168 140 L146 166 Z' }) +
        MOUTH.flat(sk) + eyeOpen(EL, ink, { lash: 'L', h: 8 }) + eyeOpen(ER, ink, { lash: 'R', h: 8 }) + brows('flat', hair.shade, 4.8) +
        hairSet(K, H, 'M246 84 L270 106 L280 142 L274 182 L266 148 L246 124 L222 112 L232 92 Z', 'M152 122 L172 98 L204 88 L182 102 L162 126 Z') + ln('M206 104 L206 82', hair.shade, 2.2) +
        earbud(K) + signal(K),
      front: clipboard(K),
    };
  },

  RGLM(K) {
    const { sk, ink, hair, creamSh, f, GC } = K;
    const curls = [[150, 130, 20], [170, 106, 22], [198, 92, 24], [228, 94, 22], [254, 110, 21], [268, 136, 18]];
    const FILL = 'M138 164 L146 120 L170 96 L206 86 L246 98 L268 124 L274 164 L262 142 L240 130 L206 126 L172 130 L150 142 Z';
    const fringe = [[160, 142, 12], [184, 132, 13], [210, 130, 13], [236, 134, 12], [256, 146, 10]];
    const cupSh = mix(f.light, f.dark, 0.4), ov = f.dark, ovSh = mix(f.dark, ink, 0.5);
    return {
      face: 'A', sil: [FACE.A, TORSO.n, FILL, ...curls.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`), '<rect x="266" y="164" width="28" height="54" rx="11"/>'],
      body: torso(K, 'n', GC) + neck(K) + crewLine(creamSh) +
        p('M162 360 L150 300 L165 296 L179 360 Z', ov) + p('M250 360 L262 300 L247 296 L233 360 Z', ovSh) +
        p('M158 356 L254 356 L260 470 L152 470 Z', ov) + p('M224 356 L254 356 L260 470 L230 470 Z', ovSh) + p('M158 356 L254 356 L255 365 L157 365 Z', mix(ov, f.light, 0.3)) +
        circ(170, 366, 5.5, CREAM) + circ(242, 366, 5.5, creamSh) + p('M184 392 L228 392 L226 426 L186 426 Z', mix(ov, f.light, 0.25)) + ln('M184 401 L228 401', ovSh, 2.5),
      head: head(K, { stubble: true, cast: 'M144 152 L160 156 L184 147 L210 145 L236 149 L256 158 L268 162 L268 172 L250 166 L236 158 L210 155 L184 157 L160 166 L144 168 Z' }) +
        MOUTH.doubt(sk) + eyeOpen(EL, ink, { h: 8 }) + eyeClosed(ER, ink, 189) + brows('angry', hair.shade, 6.5) +
        p(FILL, hair.base) + curls.map(([x, y, r], i) => circ(x, y, r, i > 3 ? hair.shade : hair.base)).join('') +
        fringe.map(([x, y, r], i) => circ(x, y, r, i > 2 ? hair.shade : hair.base)).join('') +
        ln('M140 124 q4 -10 14 -10 M160 98 q6 -10 17 -8 M190 82 q8 -8 18 -4', hair.hi, 3) +
        ln('M131 186 C118 62 292 62 279 186', ink, 11) + ln('M131 180 C124 112 162 76 206 72', mix(ink, f.light, 0.35), 3.5) +
        `<rect x="116" y="164" width="28" height="54" rx="11" fill="${f.light}"/><rect x="138" y="170" width="9" height="42" rx="4.5" fill="${ink}"/>` +
        `<rect x="266" y="164" width="28" height="54" rx="11" fill="${cupSh}"/><rect x="263" y="170" width="9" height="42" rx="4.5" fill="${ink}"/>` +
        signal(K, 112, 191),
      front: wrench(K),
    };
  },

  RGQZ(K) {
    const { sk, ink, hair, creamSh, f, G2 } = K;
    const CROWN = 'M130 144 C124 100 162 70 206 70 C250 70 288 100 282 144 Z';
    const VISOR = 'M128 152 L284 152 C278 165 252 168 206 168 C160 168 134 165 128 152 Z';
    return {
      face: 'A', sil: [CROWN, VISOR, FACE.A, TORSO.n],
      body: torso(K, 'n', G2) + neck(K) +
        p('M174 292 L206 318 L186 336 L164 302 Z', G2.light) + p('M238 292 L206 318 L226 336 L248 302 Z', G2.shade) +
        ln('M206 320 L206 470', G2.shade, 3) + circ(206, 352, 4.5, CREAM) + circ(206, 396, 4.5, CREAM) + circ(206, 440, 4.5, CREAM) +
        p('M100 320 L146 301 L152 314 L106 334 Z', ink) + ln('M112 321 L118 333 M126 315 L132 327', f.light, 3) +
        p('M312 320 L266 301 L260 314 L306 334 Z', ink) + ln('M300 321 L294 333 M286 315 L280 327', mix(f.light, f.dark, 0.4), 3) +
        ln('M118 368 L166 368 L164 404 L120 404 Z', G2.shade, 2.5) +
        ln('M174 300 L198 388', CREAM, 2.6) + ln('M238 300 L214 388', creamSh, 2.6) +
        p('M190 388 L222 388 L226 400 L216 411 L196 411 L188 400 Z', CREAM) + p('M208 388 L222 388 L226 400 L216 411 L208 411 Z', creamSh) + circ(206, 399, 4, ink),
      head: head(K, { cast: 'M138 168 L270 168 L270 179 L138 179 Z' }) + MOUTH.smile(sk) +
        eyeOpen(EL, ink, { y: 192, h: 8 }) + eyeOpen(ER, ink, { y: 192, h: 8 }) + brows('flat', hair.shade, 5.5, 9) +
        p('M135 184 L133 156 L147 156 L145 176 Z', hair.base) + p('M273 186 L275 156 L261 156 L263 176 Z', hair.shade) +
        p(CROWN, f.dark) + p('M232 72 C268 80 288 106 282 144 L236 144 L246 110 Z', K.dk1) +
        p('M131 138 L281 138 L280 154 L132 154 Z', ink) + p('M194 100 L218 100 L220 120 L206 130 L192 120 Z', f.light) + p('M206 100 L218 100 L220 120 L206 130 Z', mix(f.light, f.dark, 0.35)) +
        p(VISOR, mix(ink, '#000000', 0.3)) + p('M134 154 L206 154 L206 158 L140 160 Z', mix(ink, f.main, 0.3)) +
        ln('M133 206 q-8 7 0 14 q8 7 0 14 q-8 7 0 14 q8 7 3 16', CREAM, 2.2) + earbud(K) + signal(K),
      front: stopwatch(K),
    };
  },

  RGQM(K) {
    const { sk, ink, hair, f, G2 } = K;
    const TAIL = 'M260 118 C292 114 314 150 306 198 C302 228 292 246 286 270 C274 248 268 214 274 182 C276 160 272 138 260 118 Z';
    const H = 'M136 178 L132 140 L142 106 L168 84 L206 76 L246 84 L270 106 L280 140 L274 178 L268 158 L256 150 L240 156 L224 148 L208 156 L192 149 L176 157 L160 150 L144 160 Z';
    const HOOD = 'M150 304 C148 264 180 248 206 248 C232 248 264 264 262 304 L246 314 L166 314 Z';
    return {
      face: 'D', torso: 'slim', sil: [TAIL, H, FACE.D, TORSO.slim, HOOD],
      back: p(TAIL, hair.base) + p('M284 122 C304 136 312 164 306 198 C302 228 292 246 286 270 C284 240 292 200 292 170 C292 150 290 134 284 122 Z', hair.shade) + p('M262 124 L276 118 L280 130 L266 136 Z', f.light),
      body: p(HOOD, K.dk1) + torso(K, 'slim', G2) + neck(K, 'slim') +
        p('M168 284 C186 298 226 298 244 284 L248 314 C226 326 186 326 164 314 Z', G2.light) + p('M206 294 C222 294 236 290 244 284 L248 314 C236 320 222 324 206 324 Z', G2.base) +
        `<g clip-path="url(#${K.id}torso)">${p('M70 374 L342 374 L342 394 L70 394 Z', f.light)}${p('M222 374 L342 374 L342 394 L226 394 Z', mix(f.light, f.dark, 0.35))}</g>` +
        ln('M206 296 L206 470', CREAM, 3.2) + `<rect x="201.5" y="326" width="9" height="16" rx="3" fill="${CREAM}"/>`,
      head: head(K, { face: 'D', nose: 'small', cast: 'M144 166 L160 156 L176 163 L192 155 L208 162 L224 154 L240 162 L256 156 L268 164 L268 174 L256 165 L240 171 L224 163 L208 171 L192 164 L176 172 L160 165 L144 176 Z' }) +
        MOUTH.worry(sk) + eyeOpen(EL, ink, { y: 191, h: 10, r: 5.2, lash: 'L' }) + eyeOpen(ER, ink, { y: 191, h: 10, r: 5.2, lash: 'R' }) + brows('worried', hair.shade, 4.6, 0) +
        circ(EL, 191, 22, f.light, ' opacity=".3"') + circ(ER, 191, 22, f.light, ' opacity=".3"') + p('M156 184 L166 172 L172 172 L158 190 Z', '#FFFFFF', ' opacity=".85"') +
        `<g fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round"><circle cx="${EL}" cy="191" r="22"/><circle cx="${ER}" cy="191" r="22"/><path d="M194 188 Q205 182 216 188 M150 186 L139 181 M260 186 L270 181"/></g>` +
        hairSet(K, H, 'M246 84 L270 106 L280 140 L274 178 L268 158 L256 150 L240 156 L240 118 Z', 'M150 122 L170 96 L204 86 L182 100 L162 126 Z') +
        p('M134 176 L142 160 L146 196 L141 212 L135 204 Z', hair.base) + p('M276 178 L268 160 L264 196 L269 212 L275 204 Z', hair.shade) +
        earbud(K, 126, 190) + signal(K, 122, 200),
      front: magnifier(K),
    };
  },

  RXLZ(K) {
    const { sk, ink, hair, creamSh, G2 } = K;
    const H = 'M134 180 L126 150 L134 118 L128 104 L146 104 L156 82 L172 90 L186 70 L204 86 L226 70 L236 88 L258 80 L262 102 L282 112 L274 132 L286 152 L274 182 L268 152 L254 136 L238 148 L226 128 L208 146 L192 126 L176 148 L160 132 L148 152 L140 158 Z';
    const HOOD = 'M146 306 C144 262 176 244 206 244 C236 244 268 262 266 306 L248 318 L164 318 Z';
    return {
      face: 'A', sil: [H, FACE.A, TORSO.n, HOOD],
      body: p(HOOD, K.dk1) + torso(K, 'n', G2) + p('M184 296 L228 296 L206 326 Z', CREAM) + neck(K) +
        p('M170 290 Q206 334 242 290 L250 300 Q206 352 162 300 Z', K.dk1) +
        ln('M188 322 L184 384', CREAM, 3.5) + ln('M224 322 L228 376', creamSh, 3.5) + circ(184, 388, 4, CREAM) + circ(228, 380, 4, creamSh) +
        ln('M140 424 L272 424', K.dk1, 3) +
        ln('M133 208 C128 262 176 322 204 344 C216 352 230 356 236 372', CREAM, 2.2) + `<rect x="230" y="370" width="12" height="20" rx="6" fill="${CREAM}"/>` + p('M236 370 a6 6 0 0 1 6 6 v8 a6 6 0 0 1 -6 6 Z', creamSh),
      head: head(K, { cast: 'M140 166 L148 158 L160 140 L176 156 L192 134 L208 154 L226 136 L238 156 L254 144 L268 160 L268 170 L254 154 L238 166 L226 147 L208 164 L192 145 L176 166 L160 151 L150 168 L142 174 Z' }) +
        MOUTH.doubt(sk) + eyeOpen(EL, ink, { h: 7 }) + eyeOpen(ER, ink, { h: 9 }) + brows('raisedR', hair.shade, 6.5, 6) +
        hairSet(K, H, 'M236 88 L258 80 L262 102 L282 112 L274 132 L286 152 L274 182 L268 152 L254 136 L244 142 Z', 'M148 124 L158 98 L170 106 L161 130 Z M188 102 L192 82 L202 96 L198 114 Z') +
        earbud(K) + signal(K),
      front: coin(K),
    };
  },

  RXLM(K) {
    const { sk, ink, hair, creamSh, f, G1 } = K;
    const BACK = 'M130 176 C124 118 158 78 206 76 C254 76 286 110 284 150 C306 150 340 136 386 146 C366 166 344 172 324 178 C350 186 372 186 398 198 C370 220 332 222 300 216 C322 234 342 242 366 246 C336 262 298 254 276 236 L270 170 L140 170 Z';
    const SCARF = 'M240 290 C280 276 330 290 374 268 C366 292 342 304 318 306 C342 310 364 306 386 314 C356 336 300 332 256 314 Z';
    const scSh = mix(f.light, f.dark, 0.32);
    return {
      face: 'B', torso: 'slim', sil: [BACK, FACE.B, TORSO.slim, SCARF],
      back: p(BACK, hair.base) + p('M324 178 C350 186 372 186 398 198 C370 220 332 222 300 216 C290 204 286 190 284 176 C298 180 312 180 324 178 Z', hair.shade) +
        ln('M292 156 C316 158 342 152 368 150 M298 222 C318 236 338 242 356 244', hair.hi, 2.6),
      body: torso(K, 'slim', G1) + neck(K, 'slim') + ln('M206 330 L206 470', ink, 3.2) +
        p('M150 308 L176 292 L202 324 L188 356 L160 346 L146 328 Z', CREAM) + p('M262 308 L236 292 L210 324 L224 356 L252 346 L266 328 Z', creamSh) +
        ln('M160 346 L166 334 M174 352 L178 338 M252 346 L246 334 M238 352 L234 338', mix(creamSh, ink, 0.25), 2.4) +
        p(SCARF, f.light) + p('M318 306 C342 310 364 306 386 314 C356 336 300 332 256 314 L262 300 C282 308 300 308 318 306 Z', scSh) +
        p('M168 280 C186 294 226 294 244 280 L248 302 C226 316 186 316 164 302 Z', f.light) + p('M206 290 C222 290 236 286 244 280 L248 302 C236 310 222 313 206 313 Z', scSh),
      head: head(K, { face: 'B', nose: 'small', cast: 'M140 160 L270 152 L270 164 L140 172 Z' }) + MOUTH.grin(sk) +
        eyeHappy(EL, ink, 190) + eyeHappy(ER, ink, 190) + brows('up', hair.shade, 4.6, 8) +
        hairSet(K, SLEEK, SLEEK_SH, SLEEK_HI) +
        p('M134 132 L279 124 L280 142 L135 150 Z', ink) +
        `<rect x="150" y="116" width="50" height="36" rx="13" fill="${CREAM}"/><rect x="212" y="113" width="50" height="36" rx="13" fill="${creamSh}"/>` +
        `<rect x="156" y="122" width="38" height="24" rx="9" fill="${mix(f.light, '#FFFFFF', 0.25)}"/><rect x="218" y="119" width="38" height="24" rx="9" fill="${mix(f.light, f.dark, 0.3)}"/>` +
        p('M160 144 L174 124 L182 124 L168 144 Z', '#FFFFFF') + p('M198 130 L214 128 L214 136 L198 138 Z', ink) +
        earbud(K) + signal(K),
      front: paperPlane(K),
    };
  },

  RXQZ(K) {
    const { sk, ink, hair, creamSh, f, G2 } = K;
    const DOME = 'M132 152 C124 100 164 66 206 66 C248 66 288 100 280 152 Z';
    const BRIM = 'M128 140 L284 140 L282 168 L130 168 Z';
    const brim = mix(f.dark, f.light, 0.5);
    const vest = f.ink, vestD = mix(f.ink, '#000000', 0.32), vestL = mix(f.ink, f.dark, 0.45);
    return {
      face: 'A', sil: [DOME, BRIM, FACE.A, TORSO.n],
      body: torso(K, 'n', G2) + neck(K) + rollneck(G2.light, G2.base, K.dk1, K.dk1) +
        p('M108 316 C122 306 138 300 150 298 L168 292 L190 470 L92 470 L100 380 Z', vest) + p('M108 316 C122 306 138 300 150 298 L152 307 C140 309 126 315 117 322 L104 398 L100 380 Z', vestL) +
        p('M304 316 C290 306 274 300 262 298 L244 292 L222 470 L320 470 L312 380 Z', vestD) +
        ln('M103 356 L176 350 M99 398 L182 392 M95 440 L187 434', vestL, 2.4) + ln('M309 356 L236 350 M313 398 L230 392 M317 440 L225 434', mix(vestD, f.dark, 0.3), 2.4) +
        p('M132 306 L150 300 L162 470 L140 470 Z', f.light) + p('M280 306 L262 300 L250 470 L272 470 Z', mix(f.light, f.dark, 0.4)) +
        `<rect x="138" y="372" width="22" height="12" rx="3" fill="${ink}"/><rect x="252" y="372" width="22" height="12" rx="3" fill="${ink}"/>`,
      head: head(K, { stubble: true, cast: 'M138 168 L270 168 L270 178 L138 178 Z' }) + MOUTH.smile(sk) +
        eyeOpen(EL, ink, { y: 193, h: 7 }) + eyeOpen(ER, ink, { y: 193, h: 7 }) + brows('up', mix(hair.shade, sk.deep, 0.65), 5.5, 14) +
        p('M140 166 L158 166 L150 186 L141 180 Z M158 166 L178 166 L166 181 Z', hair.base) + p('M258 166 L272 166 L270 184 Z', hair.shade) +
        p(DOME, f.dark) + p('M234 68 C270 78 288 106 280 152 L236 152 L246 110 Z', K.dk1) + p('M150 110 L168 86 L200 74 L178 90 L160 116 Z', mix(f.dark, f.light, 0.3)) +
        p(BRIM, brim) + p('M236 140 L284 140 L282 168 L238 168 Z', mix(brim, f.dark, 0.5)) +
        ln('M146 144 v20 M162 144 v20 M178 144 v20 M194 144 v20 M210 144 v20 M226 144 v20 M242 144 v20 M258 144 v20 M272 144 v20', K.dk1, 2, ' opacity=".55"') +
        earbud(K) + signal(K),
      front: thumbsUp(K),
    };
  },

  RXQM(K) {
    const { sk, ink, hair, creamSh, f, GC } = K;
    const BACK = 'M126 190 C116 126 152 76 206 76 C260 76 296 126 286 190 C292 220 282 244 292 270 C300 296 290 318 300 344 C282 350 262 340 256 320 L250 250 L162 250 L156 320 C150 340 130 350 112 344 C122 318 112 296 120 270 C130 244 120 220 126 190 Z';
    const H = 'M134 184 L130 142 L142 108 L168 86 L206 78 L246 84 L270 106 L282 142 L278 184 L270 152 L252 128 L232 116 L212 110 L196 124 L172 134 L152 150 L140 166 Z';
    const BOARD = 'M330 24 C358 58 368 150 368 250 C368 340 358 422 348 480 L312 480 C302 422 292 340 292 250 C292 150 302 58 330 24 Z';
    const lockL = 'M128 200 C122 230 132 250 124 276 C116 300 126 322 118 344 C134 350 152 340 156 320 C160 296 150 280 154 258 C156 240 150 220 146 204 Z';
    const lockR = 'M284 200 C290 230 280 250 288 276 C296 300 286 322 294 344 C278 350 260 340 256 320 C252 296 262 280 258 258 C256 240 262 220 266 204 Z';
    const shirt = f.dark, shirtSh = K.dk1;
    return {
      face: 'B', torso: 'slim', sil: [`<path d="${BOARD}" transform="rotate(8 330 250)"/>`, BACK, H, FACE.B, TORSO.slim],
      back: `<g transform="rotate(8 330 250)">${p(BOARD, CREAM)}${p('M334 28 C358 62 368 150 368 250 C368 340 358 422 348 480 L334 480 Z', creamSh)}<rect x="326" y="44" width="8" height="436" fill="${f.dark}"/>${circ(330, 150, 10, f.dark)}</g>` +
        p(BACK, hair.base) + p('M250 250 L256 320 C262 340 282 350 300 344 C290 318 300 296 292 270 C282 244 292 220 286 190 C288 170 286 150 278 132 L268 160 Z', hair.shade),
      body: torso(K, 'slim', GC) + neck(K, 'slim') + ln('M170 300 Q206 334 242 300', creamSh, 4) +
        p('M70 470 L86 358 C94 332 122 310 154 302 L174 294 L182 470 Z', shirt) + p('M342 470 L326 358 C318 332 290 310 258 302 L238 294 L230 470 Z', shirtSh) +
        `<g fill="${f.light}" opacity=".6"><ellipse cx="116" cy="386" rx="15" ry="6" transform="rotate(-32 116 386)"/><ellipse cx="140" cy="436" rx="15" ry="6" transform="rotate(22 140 436)"/><ellipse cx="296" cy="380" rx="15" ry="6" transform="rotate(30 296 380)"/><ellipse cx="282" cy="436" rx="15" ry="6" transform="rotate(-18 282 436)"/></g>` +
        p('M174 294 L152 302 L142 336 L181 344 Z', mix(shirt, f.light, 0.4)) + p('M238 294 L260 302 L270 336 L231 344 Z', shirt),
      head: head(K, { face: 'B', ears: false, nose: 'small', cast: 'M140 170 L152 154 L172 138 L196 128 L212 114 L232 120 L252 132 L270 156 L270 168 L250 142 L232 130 L214 124 L198 138 L174 148 L154 164 L142 180 Z' }) +
        MOUTH.grin(sk) + eyeHappy(EL, ink, 190) + eyeHappy(ER, ink, 190) + brows('up', hair.shade, 4.6, 8) +
        hairSet(K, H, 'M246 84 L270 106 L282 142 L278 184 L270 152 L252 128 L232 116 L238 98 Z', 'M150 122 L170 98 L204 88 L182 102 L162 128 Z') +
        p(lockL, hair.base) + p(lockR, hair.shade) + ln('M136 230 C130 252 140 270 132 296', hair.hi, 3) +
        `<g transform="rotate(-6 206 102)"><rect x="156" y="88" width="44" height="27" rx="11" fill="${ink}"/><rect x="212" y="88" width="44" height="27" rx="11" fill="${mix(ink, '#000000', 0.3)}"/><path d="M200 99 Q206 95 212 99" fill="none" stroke="${ink}" stroke-width="4"/><path d="M164 95 L178 95 M220 95 L232 95" fill="none" stroke="${f.light}" stroke-width="2.6" stroke-linecap="round"/></g>` +
        earbud(K, 126, 188) + signal(K, 122, 198),
      front: wave(K),
    };
  },
};

function render(per) {
  const K = ctx(per);
  return compose(per, K, BUILD[per.code](K));
}

export default function posterSet() {
  return PERSONAS.map((per) => ({ code: per.code, svg: render(per) }));
}
