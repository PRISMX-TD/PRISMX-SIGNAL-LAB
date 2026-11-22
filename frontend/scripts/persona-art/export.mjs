// 交易人格插画导出（2026-11-22）：16 个人格 × 两种画风。
// - 海报（poster）：SVG 本身就小（每张约 7KB），原样写成 public/persona-art/poster/CODE.svg。
// - 体素手办（voxel）：SVG 每张约 150KB，用无头浏览器画成 600×690 的 webp，写到 public/persona-art/voxel/CODE.webp。
// 改了人物造型就重新跑一次：
//   node scripts/persona-art/export.mjs [chrome.exe 路径]
// 需要 playwright-core（不在项目依赖里；用 NODE_PATH 指到装了它的目录即可），以及一个本机 Chrome / Chromium。
//
// Persona art export: 16 personas x 2 styles. Posters ship as SVG; voxel figures are rasterised
// to 600x690 webp with a headless browser. Re-run after changing a character. Needs playwright-core
// (not a project dependency; point NODE_PATH at an install) and a local Chrome/Chromium.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import voxelSet from './voxelSet.mjs';
import posterSet from './posterKit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../public/persona-art');
const W = 600;
const H = 690;

mkdirSync(path.join(out, 'poster'), { recursive: true });
mkdirSync(path.join(out, 'voxel'), { recursive: true });

for (const { code, svg } of posterSet()) {
  writeFileSync(path.join(out, 'poster', `${code}.svg`), svg.replace(/\r\n/g, '\n'));
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const exe = process.argv[2] || process.env.CHROME_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: W, height: H } });
for (const { code, svg } of voxelSet()) {
  const sized = svg.replace('<svg ', `<svg width="${W}" height="${H}" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
  const dataUrl = await page.evaluate(async ([w, h]) => {
    const el = document.querySelector('svg');
    const blob = new Blob([new XMLSerializer().serializeToString(el)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return c.toDataURL('image/webp', 0.86);
  }, [W, H]);
  writeFileSync(path.join(out, 'voxel', `${code}.webp`), Buffer.from(dataUrl.split(',')[1], 'base64'));
}
await browser.close();
console.log('persona art written to', out);
