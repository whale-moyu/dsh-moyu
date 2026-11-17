// game-brief.mjs —— 进游戏前先跑这个，把它吐出来的东西读完再动手。
// 用法:
//   node ~/.dsh/moyu/tools/game-brief.mjs            多份笔记时只列名字+每份前 2 条速查
//   node ~/.dsh/moyu/tools/game-brief.mjs 塔防        按名字筛，整段打速查
// 设计：不认死哪款游戏，按目录里实际有什么来读。
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'C:/Users/Administrator/Desktop/阿鲸的日记本/游戏';
const pick = process.argv.slice(2).join(' ').trim();

const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter(f => f.endsWith('.md') && f !== '模板.md')
  : [];

if (!files.length) {
  console.log(`[game-brief] 没有游戏笔记（${DIR} 里没有 md）`);
  process.exit(0);
}

function quickBlock(file) {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s*速查/.test(l));
  if (start < 0) {
    return { hasQuick: false, block: lines.slice(0, 12).join('\n').trim() };
  }
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return { hasQuick: true, block: lines.slice(start, end < 0 ? lines.length : end).join('\n').trim() };
}

if (pick) {
  const hit = files.filter(f => f.includes(pick));
  if (!hit.length) {
    console.log(`[game-brief] 没有叫「${pick}」的笔记。现有：${files.join(' / ')}`);
    process.exit(0);
  }
  for (const f of hit) {
    const q = quickBlock(f);
    console.log(`========== ${f} ==========`);
    console.log(q.hasQuick ? q.block : `（没有「## 速查」段，这里是前 12 行）\n\n${q.block}`);
    console.log('');
  }
  console.log('[game-brief] 读完再开游戏。');
  process.exit(0);
}

// 无参数：只有一份就整段打，多份只给名字 + 每份前两条
if (files.length === 1) {
  const q = quickBlock(files[0]);
  console.log(`[game-brief] 只有一份笔记：${files[0]}`);
  console.log('');
  console.log(q.hasQuick ? q.block : `（没有「## 速查」段，这里是前 12 行）\n\n${q.block}`);
  console.log('');
  console.log('[game-brief] 读完再开游戏。');
  process.exit(0);
}

console.log(`[game-brief] 有 ${files.length} 份游戏笔记：`);
for (const f of files) {
  const q = quickBlock(f);
  const heads = q.block.split(/\r?\n/).filter(l => /^\d+\./.test(l.trim())).slice(0, 2);
  console.log(`\n--- ${f} ${q.hasQuick ? '' : '（无速查段）'}`);
  for (const h of heads) console.log(h.trim());
}
console.log('\n[game-brief] 玩哪一个就跑：node ~/.dsh/moyu/tools/game-brief.mjs <名字片段>');
