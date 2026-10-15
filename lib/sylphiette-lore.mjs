/**
 * sylphiette-lore —— 希露菲 preset 的「世界书」能力
 * ---------------------------------------------------------------------------
 * 存在意义：DSH 内核**没有** SillyTavern 那种世界书机制（已全盘字节级扫描确认：
 * 121MB 归档里 `world_info` / `lorebook` / `character_book` / 「世界书」全部 0 命中）。
 * 453 条设定若全塞进 persona 的 prefix，等于每一轮请求都付 3.7 万 token，
 * 既贵又把真正重要的对话挤到角落。
 *
 * 这个插件把世界书做成**两条通道**：
 *
 *  ① 自动注入（关键词触发，最像 ST 的世界书）
 *     监听 `agent/inbox/claimed` 缓存本轮（及最近 N 轮）用户输入 →
 *     在系统提示里注册一个 `text` 为**函数**的 section，
 *     每轮 assemble 时同步求值：命中的条目拼成一段塞进系统提示，不命中返回 ''
 *     （返回空串的段会被 renderPrompt 丢掉 → 自动撤下，不留残留）。
 *     时序依据：preStep 里 `inbox.claim()`（emit claimed）→ `assemble()`（调 text 函数），
 *     所以缓存 claimed 就能在 assemble 时看到「这一轮」的输入。
 *     ⚠️ text 必须是同步函数 —— 源码是 `section.text(context)` 直接取返回值，不 await。
 *
 *  ② 主动检索（lore_lookup 工具）
 *     自动注入只挑最相关的几条；模型想深挖时（"剑神流的等级怎么排的""拉诺亚大学学费多少"）
 *     可以自己调工具按关键词或 uid 查全部 453 条。
 *
 * 为什么不用 `agent/pre-step` 改写 messages：那条路 append-only，注入过的条目
 * 会永久留在会话历史里，做不到"不命中就撤下"的 ST 语义。系统提示级才是对的。
 *
 * 只依赖 node 内置模块（与 take-photo.mjs 同款做法，避免包解析问题）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'sylphiette-lore'

/**
 * 插件自身所在目录。有了它，`lorebook` 就能写成相对本插件的路径（默认同级目录），
 * 于是同一个 preset 目录拷到任何机器、任何用户名下都能直接跑，不必改配置里的绝对路径。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** systemPrompt 用于动态段，tools 用于检索工具。 */
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = {
  enabled: true,
  /** 世界书 JSON 路径：绝对路径，或**相对本插件文件**的路径（默认同级目录的 lorebook.zh.json）。 */
  lorebook: '../data/lorebook.zh.json',
  /** 系统提示段落顺序：9000 晚于工具说明、靠近对话，注意力更好。 */
  order: 9100,
  /** 扫描最近几轮用户输入（含本轮）。 */
  scanTurns: 2,
  /** 单轮最多自动注入几条。 */
  maxEntries: 6,
  /** 单轮自动注入的字符上限。 */
  maxChars: 2600,
  /** 中文关键词最短长度（太短会误触发，如「火」「剑」）。 */
  minKeyLenZh: 2,
  /** 英文关键词最短长度。 */
  minKeyLenEn: 3,
  /** 不参与自动注入的 uid（人设 prefix 里已经常驻写死的那些）。 */
  excludeUids: [],
  /** 注入段落标题（可关掉，改成 ''）。 */
  heading: '【世界设定·本轮自动调取的资料】',
  /** 命中时是否在末尾附一行提示（让模型知道还能主动检索）。 */
  hint: true,
}

/**
 * 中文长键的切分符。
 *
 * 为什么需要：译者给出的 keys_zh 常常是「爱丽儿的护卫」「沉默的菲兹」这种描述性长键，
 * 而用户嘴里说的是「爱丽儿」「菲兹」——整词 includes 命中不了。所以把长键切成片段，
 * 让核心词（爱丽儿 / 菲兹）也能触发，只是**权重减半**，排在精确命中之后。
 */
const ZH_SPLIT = /[的·・｜|,，、/\\+&和与及之（）()\[\]【】]+/u

/**
 * 中文专名的类别后缀。剥掉它就能拿到核心词，让「阿斯拉王位」也能命中「阿斯拉王国」。
 * 顺序有讲究：长的排前面（「魔法大学」要先于「大学」命中，才能得到「拉诺亚」而不是「拉诺亚魔法」）。
 */
const ZH_SUFFIXES = [
  '魔法大学', '佣兵团', '骑士团', '冒险者公会', '魔术公会', '大森林',
  '王国', '公国', '帝国', '领地', '地区', '大陆', '山脉', '森林', '村庄', '村落',
  '大学', '学园', '学院', '学校', '道场', '公会', '教会', '神殿', '商会', '家族',
  '迷宫', '遗迹', '要塞', '港口', '平原', '沙漠', '峡谷', '海岸', '岛屿', '街道',
  '流派', '之型', '魔法', '魔术', '斗气', '魔眼', '魔道具', '魔物品', '咒术', '仪式',
  '一族', '流', '族', '级', '阶', '术', '剑',
]

/**
 * 生成检索键：完整键权重 2，切分片段与剥后缀得到的核心词权重 1。
 * @returns {{ k: string, w: number }[]}
 */
function deriveZhKeys(keys, minLen) {
  const out = new Map()
  const put = (k, w) => {
    const s = String(k).trim()
    if (s.length < minLen) return
    const old = out.get(s)
    if (old === undefined || old < w) out.set(s, w)
  }
  for (const raw of keys) {
    const k = String(raw).trim()
    if (k === '') continue
    put(k, 2)
    for (const piece of k.split(ZH_SPLIT)) put(piece, 1)
    // 剥类别后缀（最多两层）：拉诺亚魔法大学 → 拉诺亚魔法 → 拉诺亚
    let cur = k
    for (let depth = 0; depth < 2; depth += 1) {
      const next = stripSuffix(cur)
      if (next === null) break
      put(next, 1)
      cur = next
    }
  }
  return [...out.entries()].map(([k, w]) => ({ k, w }))
}

function stripSuffix(word) {
  for (const s of ZH_SUFFIXES) {
    if (word.length - s.length >= 2 && word.endsWith(s)) return word.slice(0, word.length - s.length)
  }
  return null
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  if (cfg.enabled === false) return

  const configured = String(cfg.lorebook || DEFAULTS.lorebook).trim()
  if (configured === '') throw new Error('sylphiette-lore: config.lorebook 不能为空')
  const lorePath = path.isAbsolute(configured) ? configured : path.resolve(HERE, configured)

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(lorePath, 'utf8'))
  } catch (err) {
    throw new Error(`sylphiette-lore: 读不出世界书 ${lorePath} —— ${err?.message ?? err}`)
  }
  if (!Array.isArray(raw)) throw new Error(`sylphiette-lore: ${lorePath} 顶层不是数组`)

  const exclude = new Set((cfg.excludeUids ?? []).map((n) => Number(n)))
  const all = []
  const auto = []
  for (const e of raw) {
    if (e === null || typeof e !== 'object') continue
    const zh = typeof e.zh === 'string' ? e.zh : ''
    if (zh === '') continue
    const uid = Number(e.uid)
    const keysZh = deriveZhKeys(Array.isArray(e.keys_zh) ? e.keys_zh : [], Number(cfg.minKeyLenZh))
    const keysEn = (Array.isArray(e.keys_en) ? e.keys_en : [])
      .map((k) => String(k).trim())
      .filter((k) => k.length >= Number(cfg.minKeyLenEn))
    const item = {
      uid,
      keysZh,
      keysEn,
      enRe: keysEn.map((k) => new RegExp(`\\b${escapeRe(k)}\\b`, 'i')),
      text: zh,
      title: keysZh[0]?.k ?? keysEn[0] ?? `#${uid}`,
    }
    all.push(item)
    if (!exclude.has(uid)) auto.push(item)
  }

  // ── 本轮输入缓存（claim 早于 assemble，必须在这里抓）──────────────────────
  /** agent.id → [{ turn, text }]，只留最近 scanTurns 轮 */
  const history = new Map()
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (agent === undefined || agent === null) return
    const text = textOf(message)
    if (text === '') return
    const key = agent.id ?? 'default'
    const arr = history.get(key) ?? []
    const last = arr[arr.length - 1]
    if (last !== undefined && last.turn === turn) last.text += `\n${text}`
    else arr.push({ turn, text })
    while (arr.length > Math.max(1, Number(cfg.scanTurns) || 1)) arr.shift()
    history.set(key, arr)
  })

  /** 命中：中文按完整键/派生片段加权，英文按词边界（避免 Eris 命中 Ericsson）。 */
  function hits(text) {
    if (!text) return []
    const found = []
    for (const it of auto) {
      let score = 0
      for (const { k, w } of it.keysZh) {
        const s = k.length * w
        if (s > score && text.includes(k)) score = s
      }
      for (let i = 0; i < it.enRe.length; i += 1) {
        const s = it.keysEn[i].length * 2
        if (s > score && it.enRe[i].test(text)) score = s
      }
      if (score > 0) found.push({ item: it, score })
    }
    // 命中的关键词越长/越完整 → 越具体 → 排前面；同分按 uid 稳定
    found.sort((a, b) => b.score - a.score || a.item.uid - b.item.uid)
    return found
  }

  function renderInject(key) {
    const arr = history.get(key) ?? []
    const text = arr.map((r) => r.text).join('\n')
    const found = hits(text)
    if (found.length === 0) return ''
    const picked = []
    let chars = 0
    for (const h of found) {
      if (picked.length >= Number(cfg.maxEntries)) break
      // 至少放一条：即使第一条就超上限也允许，否则永远注不进去
      if (picked.length > 0 && chars + h.item.text.length > Number(cfg.maxChars)) break
      picked.push(h.item)
      chars += h.item.text.length
    }
    const body = picked.map((it) => `· ${it.text}`).join('\n')
    const hint = cfg.hint
      ? `\n（资料库共 ${all.length} 条设定。上面是自动调取的部分；需要其它细节时用 lore_lookup 查，别自己编世界观。）`
      : ''
    return cfg.heading ? `${cfg.heading}\n${body}${hint}` : `${body}${hint}`
  }

  // ── 通道 ①：系统提示级的动态段 ────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'sylphiette:lorebook',
    order: Number.isFinite(cfg.order) ? cfg.order : DEFAULTS.order,
    // ⚠️ 同步函数：assemble() 不 await。返回 '' 即本轮不注入。
    text: ({ agent }) => renderInject(agent?.id ?? 'default'),
  })

  // ── 通道 ②：lore_lookup 工具 ─────────────────────────────────────────────
  ctx.tools.register({
    name: 'lore_lookup',
    description: [
      '查六面世界的设定资料库（453 条：魔法、剑术流派、种族、地理、国家、组织、人物、魔道具、学园规则等）。',
      '',
      '什么时候用：',
      '· 需要某个专有名词的准确设定时（某个魔法、某个国家、某个流派的等级划分、某项学园规则）；',
      '· 她要提到某个地方/组织/历史事件，而你不确定细节时 —— **先查再写**，别自己编世界观；',
      '· 想确认某个名字的正确写法时。',
      '',
      '用法：',
      '· `query` 给关键词（中文优先，也认英文原名），可以给多个用空格或逗号分开；',
      '· 或 `uid` 直接取某一条（自动注入的段落里如果看到编号，可以直接按编号取全文）；',
      '· 两个都不给 → 返回资料库目录（条目编号 + 标题），可以用来发现有哪些设定可查。',
      '',
      '注意：这个工具是**给你补设定用的**，不要向她复述工具内容、不要说"我查一下资料库"。',
      '查到的东西当作你本来就记得的世界常识来用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: '关键词，例如「剑神流」「拉诺亚魔法大学 学费」「魔眼」。多个词用空格或逗号分隔。',
        },
        uid: {
          type: 'number',
          description: '直接取某一条的编号（0~452）。与 query 同时给出时优先按 uid 取。',
        },
        limit: {
          type: 'number',
          description: '最多返回几条，默认 5，上限 12。',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const limit = clamp(Number(args?.limit) || 5, 1, 12)
      const uidRaw = args?.uid
      const uid = uidRaw === undefined || uidRaw === null || uidRaw === '' ? null : Number(uidRaw)

      if (uid !== null && Number.isFinite(uid)) {
        const it = all.find((x) => x.uid === uid)
        if (it === undefined) return { text: `资料库里没有编号 ${uid} 的条目（范围 0~${all.length - 1}）。` }
        return { text: format(it) }
      }

      const q = String(args?.query ?? '').trim()
      if (q === '') {
        const lines = all.map((it) => `${it.uid}\t${it.title}`)
        return {
          text: [
            `资料库目录（共 ${all.length} 条）。用 lore_lookup 的 query 关键词查内容，或按 uid 取某一条全文。`,
            '',
            ...lines,
          ].join('\n'),
        }
      }

      const terms = q.split(/[\s,，、;；/]+/u).map((s) => s.trim()).filter((s) => s !== '')
      const scored = []
      for (const it of all) {
        let score = 0
        for (const t of terms) {
          const lower = t.toLowerCase()
          // 标题/关键词命中权重高于正文命中（完整键权重 2、派生片段 1）
          for (const { k, w } of it.keysZh) {
            if (k.includes(t) || t.includes(k)) {
              score += 100 * w
              break
            }
          }
          if (it.keysEn.some((k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))) score += 100
          if (it.text.includes(t)) score += 10
          if (it.title.includes(t)) score += 50
        }
        if (score > 0) scored.push({ it, score })
      }
      if (scored.length === 0) {
        return { text: `资料库里没有匹配「${q}」的条目。可以换关键词，或先不带参数看一眼目录。` }
      }
      scored.sort((a, b) => b.score - a.score || a.it.uid - b.it.uid)
      const picked = scored.slice(0, limit).map((s) => s.it)
      return {
        text: [
          `「${q}」命中 ${scored.length} 条，返回最相关的 ${picked.length} 条：`,
          '',
          ...picked.map(format),
        ].join('\n'),
      }
    },
  })
}

function format(it) {
  return `【#${it.uid}｜${it.title}】\n${it.text}`
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}
