/**
 * dsh-memory-scope-gate — Client half (v0.1.0).
 *
 * 输入框左侧（conversation.input.left）一个紧凑开关：
 *   「记忆·本区」 ⇄ 「记忆·全局」
 * 点一下通过回环路由写会话级层级，Host 侧的闸立刻按新层级放行/拦截。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-scope-gate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ENDPOINT = '/dsh-memory-scope-gate/state'

    const STRINGS = {
      zh: {
        labelWorkspace: '记忆·本区',
        labelGlobal: '记忆·全局',
        titleWorkspace: '记忆披露层级：本工作区。engram_* 只能访问当前工作区的记忆库，点一下切到全局。',
        titleGlobal: '记忆披露层级：全局。engram_* 可访问私人库与共享库（跨工作区），点一下收回本工作区。',
        failed: '切换没保存成功',
      },
      en: {
        labelWorkspace: 'Memory: local',
        labelGlobal: 'Memory: global',
        titleWorkspace: 'Memory disclosure: this workspace only. engram_* may read the current workspace store; click to widen to global.',
        titleGlobal: 'Memory disclosure: global. engram_* may reach the private and shared stores across workspaces; click to narrow back.',
        failed: 'Could not save the change',
      },
    }

    function strings() {
      const lang = typeof document !== 'undefined' && document.documentElement
        ? String(document.documentElement.lang || '')
        : ''
      return lang.toLowerCase().indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en
    }

    const style = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 24,
      padding: '0 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.32))',
      background: 'transparent',
      color: 'var(--dsw-alias-fg-secondary, #8a8a8a)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    }

    const styleGlobal = {
      ...style,
      color: 'var(--dsw-alias-accent, #3b82f6)',
      borderColor: 'var(--dsw-alias-accent, #3b82f6)',
    }

    function Chip(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [level, setLevel] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const t = strings()

      React.useEffect(() => {
        let alive = true
        if (sessionId.length === 0) return undefined
        fetch(ENDPOINT + '?session=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .then((data) => {
            if (alive && data && (data.level === 'workspace' || data.level === 'global')) setLevel(data.level)
          })
          .catch(() => {
            if (alive) setLevel('workspace')
          })
        return () => {
          alive = false
        }
      }, [sessionId])

      const global = level === 'global'
      const label = level === null ? t.labelWorkspace : (global ? t.labelGlobal : t.labelWorkspace)
      const title = level === null ? t.titleWorkspace : (global ? t.titleGlobal : t.titleWorkspace)

      const toggle = () => {
        if (sessionId.length === 0) return
        const next = global ? 'workspace' : 'global'
        const previous = level
        setLevel(next)
        setFailed(false)
        fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, level: next }),
        })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .then((data) => {
            if (!data || data.persisted === false) setFailed(true)
          })
          .catch(() => {
            setLevel(previous)
            setFailed(true)
          })
      }

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          title: failed ? title + ' — ' + t.failed : title,
          'aria-label': title,
          'aria-pressed': global,
          'data-memory-scope-gate': level === null ? 'unknown' : level,
          style: global ? styleGlobal : style,
        },
        h('span', { 'aria-hidden': true, style: { fontSize: 11, opacity: 0.9 } }, global ? '◉' : '◎'),
        h('span', null, label),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'memory-scope-gate', order: 40 },
            Chip,
          ),
        )
      },
    }
  },
})
