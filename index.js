/**
 * dsh-memory-scope-gate — Host half (v0.2.0).
 *
 * 记忆披露闸：给 `engram_*` 工具调用按 **会话** 加一层访问控制。
 *
 * 两条防线（「本区」档位下）：
 *   1. 带 `scope` 参数的工具：只放行 `scope:"project"`。
 *      省略 scope（engram 默认合并「私人 + 项目 + 共享」三库）、`user`、`shared`、`all` 一律拦下。
 *   2. 只吃 id 的工具（`engram_examine` / `engram_neighbors`）没有 scope 可查，
 *      改为 **id 白名单**：只接受本会话检索结果里出现过、且标注为 `[project/...]` 的记忆 id。
 *      `[user/...]` 与 `[shared/...]` 行的 id 永不入白名单——切回「本区」就收回。
 *
 * 层级 `global`：两条防线都不生效。
 * 层级按 sessionId 落在 `$DSH_HOME/dsh-memory-scope-gate/levels.json`，
 * 由输入框左侧的开关（client half）经本插件的回环路由读写。
 *
 * 设计边界（诚实声明）：
 *   1. 只拦"调用层"：engram 的自动摄取（config.ingest）不经过工具层，拦不住。
 *   2. 认不出的新工具/新参数放行并写日志（宁可漏也不锁死）；能识别的都拦。
 *   3. 闸自己出错时 fail-closed：engram_* 直接拒（附错误摘要），其它工具照常。
 *   4. 闸是访问控制，不是记忆清除：已经进入会话上下文的内容，切档位不会消失。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = 'dsh-memory-scope-gate'
const LEVELS = new Set(['workspace', 'global'])
const DEFAULT_LEVEL = 'workspace'
const ROUTE_PATH = '/dsh-memory-scope-gate/state'

/** schema 里查不到 `scope` 参数时的兜底名单：这些 engram 工具带 scope。 */
const SCOPED_FALLBACK = new Set([
  'engram_search',
  'engram_timeline',
  'engram_episode_timeline',
  'engram_facts',
  'engram_save',
  'engram_update',
  'engram_forget',
  'engram_review',
  'engram_review_queue',
  'engram_audit_forgotten',
  'engram_tour',
  'engram_stats',
  'engram_export',
  'engram_import',
  'engram_distill',
  'engram_reflect',
  'engram_report',
  'engram_profile_edit',
  'engram_ingest_history',
])

/** 只吃 id、没有 scope 参数的召回工具——靠 id 白名单约束。 */
const ID_ONLY_RECALL = new Set(['engram_examine', 'engram_neighbors'])

/** 只有 `[project/...]` 行上的 id 才进白名单。 */
const PROJECT_LINE = '[project/'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function readLevels(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {}
      for (const [sessionId, level] of Object.entries(parsed)) {
        if (typeof sessionId === 'string' && LEVELS.has(level)) out[sessionId] = level
      }
      return out
    }
  } catch {
    // 首次运行或文件损坏：从空表开始，不阻塞插件激活。
  }
  return {}
}

function persistLevels(file) {
  return (levels) => {
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify(levels, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }
}

function scopeCapable(exec) {
  const props = exec?.schema?.parameters?.properties
  if (props !== null && typeof props === 'object') {
    return Object.prototype.hasOwnProperty.call(props, 'scope')
  }
  return SCOPED_FALLBACK.has(exec?.name)
}

function requestedIds(args) {
  if (args === null || typeof args !== 'object') return []
  if (Array.isArray(args.ids)) return args.ids.filter((id) => typeof id === 'string')
  if (typeof args.id === 'string') return [args.id]
  return []
}

/** 从一次工具结果的文本里收下 `[project/...]` 行上的 id。 */
function harvestProjectIds(text, into) {
  for (const line of text.split('\n')) {
    if (line.indexOf(PROJECT_LINE) === -1) continue
    const matches = line.match(UUID_RE)
    if (matches === null) continue
    for (const id of matches) into.add(id.toLowerCase())
  }
}

function describeScope(raw) {
  if (raw === undefined || raw === null || raw === '') return '未传 scope（engram 默认合并 私人+项目+共享 三库）'
  return `scope=${JSON.stringify(raw)}`
}

function scopeDenialReason(name, raw) {
  return [
    `[${PLUGIN}] 本会话的记忆披露层级 = 本工作区，${name} 的 ${describeScope(raw)} 已在 dispatch 前被拦下。`,
    '请改用 scope:"project" 重试（engram 的 project 库就是当前会话 cwd 对应的那个工作区库）。',
    '若确实需要跨工作区或全局记忆，请不要自己绕：让用户点输入框左侧的「记忆·本区」按钮切到「记忆·全局」。',
  ].join(' ')
}

function idDenialReason(name, foreignCount, knownCount) {
  return [
    `[${PLUGIN}] 本会话的记忆披露层级 = 本工作区，${name} 只接受本会话检索结果里出现过的 project 记忆 id；`,
    `这次有 ${foreignCount} 个 id 不在白名单（当前白名单 ${knownCount} 个）。`,
    '请先用 engram_search scope:"project" 检索，再从命中的 id= 里精读；',
    '要读其他工作区或全局记忆，请让用户把输入框左侧的「记忆·本区」切到「记忆·全局」。',
  ].join(' ')
}

export function apply(ctx, config) {
  const dir = join(dshHome(), PLUGIN)
  const stateFile = join(dir, 'levels.json')
  const auditFile = join(dir, 'denials.jsonl')
  const fallbackLevel = LEVELS.has(config?.defaultLevel) ? config.defaultLevel : DEFAULT_LEVEL

  let levels = readLevels(stateFile)
  const save = persistLevels(stateFile)

  /** sessionId -> 允许精读的项目记忆 id 集合（进程内，重启即清空）。 */
  const recallIds = new Map()

  const whitelistOf = (sessionId) => {
    let set = recallIds.get(sessionId)
    if (set === undefined) {
      set = new Set()
      recallIds.set(sessionId, set)
    }
    return set
  }

  const levelOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return fallbackLevel
    const stored = levels[sessionId]
    return LEVELS.has(stored) ? stored : fallbackLevel
  }

  const audit = (record) => {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8')
    } catch {
      // 审计写不进去不影响闸本身。
    }
  }

  // ---- 收 id：本会话的 engram 检索结果里，[project/...] 行上的那些 ----
  ctx.on('tools/result', (exec, result) => {
    try {
      const name = typeof exec?.name === 'string' ? exec.name : ''
      if (!name.startsWith('engram_')) return
      if (result?.isError === true) return
      const blocks = Array.isArray(result?.content) ? result.content : []
      if (blocks.length === 0) return
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      // 只有「本区」档位下看到的 project 行才记；全局档位期间看过的 user 行本就不该在切回后被精读。
      if (levelOf(sessionId) !== 'workspace') return
      const into = whitelistOf(sessionId)
      const before = into.size
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        harvestProjectIds(block.text, into)
      }
      if (into.size !== before) audit({ session: sessionId, decision: 'whitelist', added: into.size - before, total: into.size })
    } catch {
      // 收 id 失败不影响闸；最坏情况是该条 id 精读被拒。
    }
  })

  // ---- 梯门：tools/pre-execute（waterfall，decision 自带原因给模型看） ----
  const gate = async (exec, next) => {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (!name.startsWith('engram_')) return next()

    const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''

    let level
    try {
      level = levelOf(sessionId)
    } catch {
      level = fallbackLevel
    }
    if (level === 'global') return next()

    try {
      const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}

      // 防线 2：只吃 id 的召回工具
      if (ID_ONLY_RECALL.has(name)) {
        const ids = requestedIds(args)
        const known = whitelistOf(sessionId)
        const foreign = ids.filter((id) => !known.has(String(id).toLowerCase()))
        if (foreign.length > 0) {
          audit({ session: sessionId, tool: name, level, decision: 'deny-id', ids: ids.length, foreign: foreign.length })
          return {
            kind: 'deny',
            reason: idDenialReason(name, foreign.length, known.size),
            info: { name: PLUGIN, code: 'id-not-whitelisted', reason: 'workspace-only' },
          }
        }
        return next()
      }

      // 防线 1：带 scope 的工具
      if (!scopeCapable(exec)) return next()
      if (args.scope === 'project') return next()
      audit({ session: sessionId, tool: name, scope: args.scope ?? null, level, decision: 'deny' })
      return {
        kind: 'deny',
        reason: scopeDenialReason(name, args.scope),
        info: { name: PLUGIN, code: 'scope-blocked', reason: 'workspace-only' },
      }
    } catch (error) {
      // fail-closed：自己的判断出错时不要放行 engram 的跨库访问。
      const detail = error instanceof Error ? error.message : String(error)
      audit({ session: sessionId, tool: name, level, decision: 'deny-error', error: detail })
      return {
        kind: 'deny',
        reason: `[${PLUGIN}] 闸判断出错（${detail}），按 fail-closed 处理：本会话只允许 scope:"project"。`,
        info: { name: PLUGIN, code: 'gate-error' },
      }
    }
  }

  ctx.on('tools/pre-execute', gate)

  // ---- 会话结束就丢掉白名单，避免进程内无限增长 ----
  ctx.on('session/disposed', (session) => {
    const id = session?.id
    if (typeof id === 'string') recallIds.delete(id)
  })

  // ---- 系统提示词：让模型第一次就走对路径 ----
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = scope.get('systemPrompt')
    if (systemPrompt?.context === undefined) return
    systemPrompt.context({
      name: 'memory:scope-gate',
      order: 116,
      text: [
        'Memory disclosure (dsh-memory-scope-gate): memory tool calls are gated per session.',
        'Every engram_* call whose schema has a `scope` parameter MUST pass scope:"project".',
        'Omitting scope, or passing "user", "shared" or "all", is denied before dispatch unless the user',
        'switched the composer\'s memory-level control to global.',
        'engram_examine and engram_neighbors accept only ids that appeared in this session\'s own',
        'search results on a [project/...] line; an id seen elsewhere is refused.',
        'Do not work around a denial: search with scope:"project" first, then examine, or ask the user',
        'to widen the level.',
      ].join(' '),
    })
  })

  // ---- 回环路由：输入框开关读写会话级层级 ----
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined) return
    webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        }
        try {
          if (req.method === 'GET') {
            const url = new URL(req.url ?? ROUTE_PATH, 'http://127.0.0.1')
            const session = url.searchParams.get('session') ?? ''
            const level = levelOf(session)
            send(200, { session, level, defaultLevel: fallbackLevel, knownIds: whitelistOf(session).size })
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const session = typeof body?.sessionId === 'string' ? body.sessionId : ''
            const level = typeof body?.level === 'string' ? body.level : ''
            if (session.length === 0 || !LEVELS.has(level)) {
              send(400, { error: 'sessionId and level ("workspace"|"global") are required' })
              return
            }
            levels[session] = level
            if (level === 'workspace') recallIds.delete(session)
            const persisted = save(levels)
            audit({ session, level, decision: 'set', persisted })
            send(200, { session, level, persisted })
            return
          }
          send(405, { error: 'method not allowed' })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          try {
            send(500, { error: detail })
          } catch {
            res.destroy()
          }
        }
      },
    })
  })

  ctx.effect(() => () => {
    levels = {}
    recallIds.clear()
  })
}
