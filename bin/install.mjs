#!/usr/bin/env node
/**
 * dsh-sylphiette-agent —— 兜底安装器（Desktop 用户建议优先试官方途径，见 README）
 * ===========================================================================
 *   node bin/install.mjs               预览（不改任何文件）
 *   node bin/install.mjs --apply       安装
 *   node bin/install.mjs --uninstall --apply   卸载
 *
 * 可选：--home <DSH主目录>  --profile <profile名>  --patch <cordis.patch.yml 路径>
 *
 * 为什么需要它：DSH 官方命令是 `dsh plugin --profile <p> add <spec>`，但**桌面版应用的
 * 自有 profile（desktop）被 CLI 硬拒绝**（"profile is managed exclusively by the Electron
 * application"），官方 GUI 又要点好几下。这个脚本给出一条命令行兜底。
 *
 * 它做的事（不碰 pnpm、不改 profile/package.json、不动锁文件）：
 *   ① 把整个包拷到 <DSH主目录>/dsh-sylphiette-agent/
 *   ② 把包内 cordis.patch.yml 的声明内联进 profile 的 cordis.patch.yml，
 *      并把其中的 ./ 相对插件路径转成绝对 file:// URL
 *      （DSH 按「声明方」的位置解析相对路径，不转就会找不到 lib/sylphiette-lore.mjs）
 *   ③ 备份对方的 patch，然后验证
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..') // 包根
const PKG_NAME = 'dsh-sylphiette-agent'
const PRESET_ID = 'roleplay-sylphiette'
const MARK_BEGIN = `# >>> ${PKG_NAME} BEGIN (written by bin/install.mjs; delete this block to uninstall) >>>`
const MARK_END = `# <<< ${PKG_NAME} END <<<`

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const UNINSTALL = argv.includes('--uninstall')
const argOf = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}

const say = (m = '') => console.log(m)
const problems = []
const check = (label, ok, extra = '') => {
  say(`   ${ok ? 'OK  ' : 'FAIL'} ${label}${extra === '' ? '' : `　${extra}`}`)
  if (!ok) problems.push(label)
}

// ── 定位 ─────────────────────────────────────────────────────────────────
const home = path.resolve(argOf('--home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const profileName = argOf('--profile') ?? process.env.DSH_PROFILE ?? 'desktop'
const profileDir = path.join(home, 'profiles', profileName)
const patchPath = argOf('--patch') !== undefined
  ? path.resolve(argOf('--patch'))
  : path.join(profileDir, 'cordis.patch.yml')
const dest = path.join(home, PKG_NAME)

const SKIP = new Set(['node_modules', '.git', '.github'])
say(`${PKG_NAME} 安装器`)
say(`  DSH 主目录 : ${home}`)
say(`  profile    : ${profileName}  (${profileDir}${fs.existsSync(profileDir) ? '' : ' ← 不存在'})`)
say(`  patch      : ${patchPath}${fs.existsSync(patchPath) ? '' : ' ← 不存在（将新建）'}`)
say(`  安装到     : ${dest}`)
say()

// 源检查
for (const f of ['package.json', 'cordis.patch.yml', 'lib/sylphiette-lore.mjs', 'data/lorebook.zh.json']) {
  if (!fs.existsSync(path.join(SRC, f))) problems.push(`包内缺 ${f}（是不是只拷了 bin/？请解压整个包再运行）`)
}
if (problems.length > 0) {
  say(`x 包不完整：\n${problems.map((p) => `   · ${p}`).join('\n')}`)
  process.exit(1)
}

// ── 卸载 ─────────────────────────────────────────────────────────────────
if (UNINSTALL) {
  if (!APPLY) {
    say('预览卸载：会删除安装目录、并从 patch 移除本脚本写入的声明块。加 --apply 执行。')
    process.exit(0)
  }
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true })
    say(`已删除 ${dest}`)
  }
  if (fs.existsSync(patchPath)) {
    const text = fs.readFileSync(patchPath, 'utf8')
    const b = text.indexOf(MARK_BEGIN)
    const e = b === -1 ? -1 : text.indexOf(MARK_END, b)
    if (b !== -1 && e !== -1) {
      fs.copyFileSync(patchPath, `${patchPath}.bak-uninstall-${Date.now()}`)
      fs.writeFileSync(patchPath, `${text.slice(0, b)}${text.slice(e + MARK_END.length)}`.replace(/\n{3,}/gu, '\n\n'), 'utf8')
      say('已从 patch 移除声明块（原文件已备份）')
    } else {
      say('patch 里没有本脚本写入的声明块（可能当初是用官方命令装的，未改动它）')
    }
  }
  say('\n卸载完成。刷新页面或重启 DSH 后生效。')
  process.exit(0)
}

// ── 生成要内联的声明块（把 ./ 插件路径绝对化到安装后的位置）────────────────
function buildBlock() {
  const raw = fs.readFileSync(path.join(SRC, 'cordis.patch.yml'), 'utf8').replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
  const out = raw.split('\n').map((line) => {
    const m = /^(\s*-?\s*name:)\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))\s*(#.*)?$/u.exec(line)
    if (m === null) return line
    const spec = m[2] ?? m[3] ?? m[4]
    // 包内插件行（包名子路径，或 ./ 相对路径）一律落成**安装位置的绝对 file URL**：
    // 兜底安装器把包放在 <DSH主目录>/dsh-sylphiette-agent/，并不经过 profile 的 node_modules，
    // 所以包名在这里解析不到；而把 ./ 内联进 profile patch 后，它又会按 profile 目录解析。
    // 两种形态都落成绝对路径最稳。
    const SELF = {
      'dsh-sylphiette-agent/lore': 'lib/sylphiette-lore.mjs',
      './lib/sylphiette-lore.mjs': 'lib/sylphiette-lore.mjs',
      '../lib/sylphiette-lore.mjs': 'lib/sylphiette-lore.mjs',
    }
    const rel = SELF[spec]
    if (rel === undefined) return line
    const url = pathToFileURL(path.join(dest, rel)).href
    return `${m[1]} '${url}'${m[5] === undefined ? '' : ` ${m[5]}`}`
  })
  return [MARK_BEGIN, ...out, MARK_END].join('\n')
}

const block = buildBlock()

function upsert(text) {
  const b = text.indexOf(MARK_BEGIN)
  if (b !== -1) {
    const e = text.indexOf(MARK_END, b)
    if (e === -1) throw new Error('patch 里有 BEGIN 却没有 END，为免误删已中止')
    const next = text.slice(0, b) + block + text.slice(e + MARK_END.length)
    return next === text ? { next: text, action: 'unchanged' } : { next, action: 'updated' }
  }
  // 已被官方 bundle / dsh-preset-sync 等声明过？重复 id 会被注册表拒绝，所以不写
  if (new RegExp(`^\\s*id:\\s*preset-${PRESET_ID}\\s*$`, 'mu').test(text) || new RegExp(`id:\\s*${PRESET_ID}\\s*$`, 'mu').test(text)) {
    return { next: text, action: 'already-declared' }
  }
  const lines = text.split('\n')
  const at = lines.findIndex((l) => /^- id: agent-preset-registry\b/u.test(l))
  if (at !== -1) return { next: [...lines.slice(0, at), ...block.split('\n'), '', ...lines.slice(at)].join('\n'), action: 'inserted-before-registry' }
  return { next: `${text.replace(/\n+$/u, '')}\n\n${block}\n`, action: 'appended' }
}

const original = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8').replace(/\r\n/gu, '\n') : ''
let plan
try {
  plan = original === '' ? { next: `${block}\n`, action: 'created' } : upsert(original)
} catch (err) {
  say(`x ${err?.message ?? err}`)
  process.exit(1)
}

say(`① 拷贝整包 → ${dest}`)
say(`② patch 动作 : ${plan.action}`)
if (plan.action === 'already-declared') {
  say('   这份预设已被别的方式声明过（官方 bundle 或 preset 同步工具），跳过写入以免重复 id。')
  say('   ⚠️ 此时包文件会被更新，但 patch 里那份仍归那个方式管：改了人设要重跑那个方式才会生效。')
}

if (!APPLY) {
  say('\n预览完成，未改动任何文件。加 --apply 执行安装。')
  process.exit(0)
}

// ── 落盘 ─────────────────────────────────────────────────────────────────
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith('.tgz')) continue
    const s = path.join(from, entry.name)
    const d = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}
fs.rmSync(dest, { recursive: true, force: true })
copyDir(SRC, dest)
say(`   已拷贝整包：${fs.readdirSync(dest).join(', ')}`)

fs.mkdirSync(path.dirname(patchPath), { recursive: true })
if (fs.existsSync(patchPath)) {
  const backup = `${patchPath}.bak-${PKG_NAME}-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  fs.copyFileSync(patchPath, backup)
  say(`   已备份 patch：${backup}`)
}
if (plan.action !== 'already-declared') {
  fs.writeFileSync(patchPath, plan.next, 'utf8')
  say(`   已写入 patch（${original.length} → ${plan.next.length} 字符）`)
}

// ── 验证 ─────────────────────────────────────────────────────────────────
say('\n③ 验证')
for (const f of ['package.json', 'cordis.patch.yml', 'lib/sylphiette-lore.mjs', 'data/lorebook.zh.json']) {
  check(`已安装 ${f}`, fs.existsSync(path.join(dest, f)))
}
const after = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8').replace(/\r\n/gu, '\n') : ''
check('patch 里有声明', new RegExp(`id:\\s*${PRESET_ID}\\b`, 'u').test(after))
if (plan.action !== 'already-declared') check('插件路径已绝对化', after.includes('file:///') && after.includes('sylphiette-lore.mjs'))
try {
  const lore = JSON.parse(fs.readFileSync(path.join(dest, 'data', 'lorebook.zh.json'), 'utf8'))
  check('世界书可解析', Array.isArray(lore), `${lore.length} 条`)
} catch (err) {
  check(`世界书可解析（${err?.message ?? err}）`, false)
}
try {
  const mod = await import(pathToFileURL(path.join(dest, 'lib', 'sylphiette-lore.mjs')).href)
  check('插件可加载且导出 apply', typeof mod.apply === 'function' && mod.name === 'sylphiette-lore')
} catch (err) {
  check(`插件可加载（${err?.message ?? err}）`, false)
}

say(problems.length === 0
  ? [
      '',
      '安装完成。接下来：',
      '  1) 刷新 DSH 的 Web 界面（桌面版默认 http://127.0.0.1:19387），或重启 DeepSeek Harness 桌面端',
      '  2) 新建会话 → Agent 预设 选「希露菲」',
      '',
      '成人向（NSFW）内容，仅供本地个人使用。',
      `卸载：node bin/install.mjs --uninstall --apply`,
    ].join('\n')
  : `\n有 ${problems.length} 项未通过：\n${problems.map((p) => `   · ${p}`).join('\n')}`)
if (problems.length > 0) process.exit(1)
