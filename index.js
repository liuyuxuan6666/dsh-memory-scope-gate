/**
 * dsh-memory-scope-gate — Host half (v0.1.0).
 *
 * 记忆披露闸：给 `engram_*` 工具调用按 **会话** 加一层 scope 闸。
 *
 *   - 层级 `workspace`（默认）：只放行 `scope:"project"`。
 *     省略 scope（engram 会默认合并「私人 + 项目 + 共享」三库）、
 *     `user`、`shared`、`all` 一律在 dispatch 之前拦下。
 *   - 层级 `global`：不拦。
 *
 * 层级按 sessionId 落在 `$DSH_HOME/dsh-memory-scope-gate/levels.json`，
 * 由输入框左侧的开关（client half）经本插件的回环路由读写。
 *
 * 设计边界（诚实声明）：
 *   1. 只拦"调用层"：engram 的自动摄取（config.ingest）不经过工具层，拦不住。
 *   2. 只拦"带 scope 参数"的工具；schema 取不到时用 SCOPED_FALLBACK 兜底，
 *      都不认识的新工具放行并写日志（宁可漏也不锁死）。
 *   3. 闸自己出错时 fail-closed：engram_* 直接拒（附错误摘要），其它工具照常。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = 'dsh-memory-scope-gate'
const LEVELS = new Set(['workspace', 'global'])
const DEFAULT_LEVEL = 'workspace'
const ROUTE_PATH = '/dsh-memory-scope-gate/state'

/**
 * schema 里查不到 `scope` 参数时的兜底名单。
 * 只收录**确实带 scope** 的 engram 工具；没有 scope 的（engram_examine /
 * engram_neighbors / engram_assess / engram_language_guide）刻意不在表里。
 */
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

function describeScope(raw) {
  if (raw === undefined || raw === null || raw === '') return '未传 scope（engram 默认合并 私人+项目+共享 三库）'
  return `scope=${JSON.stringify(raw)}`
}

function denialReason(name, raw) {
  return [
    `[${PLUGIN}] 本会话的记忆披露层级 = 本工作区，${name} 的 ${describeScope(raw)} 已在 dispatch 前被拦下。`,
    '请改用 scope:"project" 重试（engram 的 project 库就是当前会话 cwd 对应的那个工作区库）。',
    '若确实需要跨工作区或全局记忆，请不要自己绕：让用户点输入框左侧的「记忆·本区」按钮切到「记忆·全局」。',
  ].join(' ')
}

export function apply(ctx, config) {
  const dir = join(dshHome(), PLUGIN)
  const stateFile = join(dir, 'levels.json')
  const auditFile = join(dir, 'denials.jsonl')
  const fallbackLevel = LEVELS.has(config?.defaultLevel) ? config.defaultLevel : DEFAULT_LEVEL

  let levels = readLevels(stateFile)
  const save = persistLevels(stateFile)

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
      if (!scopeCapable(exec)) return next()
      const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
      if (args.scope === 'project') return next()
      audit({ session: sessionId, tool: name, scope: args.scope ?? null, level, decision: 'deny' })
      return {
        kind: 'deny',
        reason: denialReason(name, args.scope),
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

  // ---- 系统提示词：让模型第一次就传对 scope，少一次往返 ----
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
        'switched the composer\'s memory-level control to global. Do not work around a denial: retry with',
        'scope:"project", or ask the user to widen the level.',
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
            send(200, { session, level, defaultLevel: fallbackLevel })
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
  })
}
