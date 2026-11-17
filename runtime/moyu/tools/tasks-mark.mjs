// 夜班进度记一笔：把指定行标 done，并在文末追加一行结果
// 用法：node tasks-mark.mjs <行号|关键字> done "结果文字"
import fs from 'node:fs'
const P = (process.env.USERPROFILE || 'C:/Users').replace(/\\/g, '/') + '/.dsh/moyu/TASKS.md'
const [key, status, ...rest] = process.argv.slice(2)
const note = rest.join(' ')
let s = fs.readFileSync(P, 'utf8')
// 找到含 key 的表格行，把最后一个 | pending/done/... | 换掉
const lines = s.split('\n')
let hit = -1
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('|') && lines[i].includes(key) && /\|\s*(pending|doing|done|fail)\s*\|\s*$/.test(lines[i])) { hit = i; break }
}
if (hit < 0) { console.error('没找到含 ' + key + ' 的队列表行'); process.exit(1) }
lines[hit] = lines[hit].replace(/\|\s*(pending|doing|done|fail)\s*\|\s*$/, '| ' + status + ' |')
s = lines.join('\n')
if (note) {
  const stamp = new Date().toLocaleString('sv-SE')
  s = s.replace(/\s*$/, '') + `\n\n- [${stamp}] ${key} → ${status}：${note}\n`
}
fs.writeFileSync(P, s, 'utf8')
console.log('已记：' + lines[hit].trim())
