#!/usr/bin/env node
// grid.mjs — 屏幕网格标定：把「第几列第几行」换算成屏幕坐标
//
// 为什么要有这个：截图是缩放过的（1920 宽的屏截成 1280 宽的图），
// 靠眼睛估格子中心，误差会被缩放放大成半个格子；大地图缩放后更糟。
// 只要点两个格子、读出白框中心的屏幕坐标，就能算出格宽和原点，
// 之后所有格子都按行列算，误差只剩 1px 级别，且不会随距离累积。
//
// 用法：
//   node grid.mjs cal <x1> <y1> <c1> <r1> <x2> <y2> <c2> <r2> [--note "缩放2档"] [--title "窗口标题"]
//   node grid.mjs at <col> <row>      # 输出该格子中心的屏幕坐标
//   node grid.mjs show                # 看当前标定
//   node grid.mjs clear
//
// 注意：缩放、拖拽、换关卡之后格宽会变，要重新 cal。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const FILE = path.join(HOME, 'moyu', 'tools', 'grid-calib.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

function save(o) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(o, null, 2), 'utf8');
}

function num(s, name) {
  const n = Number(s);
  if (!Number.isFinite(n)) { console.error(`not a number: ${name}=${s}`); process.exit(2); }
  return n;
}

function flag(argv, name, def = '') {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  return argv[i + 1] ?? def;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'cal') {
  const a = rest.filter(x => !x.startsWith('--'));
  if (a.length < 8) {
    console.error('usage: grid.mjs cal <x1> <y1> <c1> <r1> <x2> <y2> <c2> <r2>');
    process.exit(2);
  }
  const [x1, y1, c1, r1, x2, y2, c2, r2] = a.slice(0, 8).map((v, i) => num(v, `arg${i + 1}`));
  const dc = c2 - c1, dr = r2 - r1;
  if (dc === 0 && dr === 0) { console.error('two points are the same cell'); process.exit(2); }
  const pitchX = dc === 0 ? NaN : (x2 - x1) / dc;
  const pitchY = dr === 0 ? NaN : (y2 - y1) / dr;
  const ox = dc === 0 ? NaN : x1 - c1 * pitchX;
  const oy = dr === 0 ? NaN : y1 - r1 * pitchY;
  // 格子一般是方的：只标了横向或纵向时，另一轴照抄，标个 square 说明是推定值
  let square = false;
  let px = pitchX, py = pitchY, x0 = ox, y0 = oy;
  if (!Number.isFinite(py) && Number.isFinite(px) && Number.isFinite(y1)) { py = px; y0 = y1 - r1 * py; square = true; }
  if (!Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(x1)) { px = py; x0 = x1 - c1 * px; square = true; }
  const out = {
    pitchX: Number.isFinite(px) ? +px.toFixed(3) : null,
    pitchY: Number.isFinite(py) ? +py.toFixed(3) : null,
    originX: Number.isFinite(x0) ? +x0.toFixed(2) : null,
    originY: Number.isFinite(y0) ? +y0.toFixed(2) : null,
    square,
    title: flag(rest, '--title'),
    note: flag(rest, '--note'),
    at: new Date().toISOString(),
  };
  save(out);
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === 'at') {
  const c = load();
  if (!c) { console.error('no calibration yet — run `grid.mjs cal ...` first'); process.exit(1); }
  const [col, row] = rest.slice(0, 2).map((v, i) => num(v, `arg${i + 1}`));
  const x = c.originX + col * c.pitchX;
  const y = c.originY + row * c.pitchY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) { console.error('calibration missing an axis'); process.exit(1); }
  console.log(JSON.stringify({ col, row, x: Math.round(x), y: Math.round(y), pitchX: c.pitchX, pitchY: c.pitchY }));
} else if (cmd === 'show') {
  const c = load();
  console.log(c ? JSON.stringify(c, null, 2) : 'no calibration yet');
} else if (cmd === 'clear') {
  try { fs.unlinkSync(FILE); console.log('cleared'); } catch { console.log('nothing to clear'); }
} else {
  console.log('usage:\n  grid.mjs cal <x1> <y1> <c1> <r1> <x2> <y2> <c2> <r2> [--note ..] [--title ..]\n  grid.mjs at <col> <row>\n  grid.mjs show\n  grid.mjs clear');
}
