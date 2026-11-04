/**
 * dsh-usage-radar — Client half.
 *
 * Two slot contributions, one shared store:
 *   conversation.session.header.utilities  → the always-on ring pill
 *   shell.overlay                          → the floating radar panel
 *
 * Deliberate constraints: no Harness Client package is imported, every colour
 * comes from a --dsw-alias-* token (data-viz hue per severity), and the panel is
 * a plain React tree so unmounting removes it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-radar',
  factory: (require) => {
    try {
      const React = require('react')
      const h = React.createElement

      const PILL_SLOT = 'conversation.session.header.utilities'
      const OVERLAY_SLOT = 'shell.overlay'
      const API = '/dsh-usage-radar/api'
      const STYLE_ID = 'dsh-usage-radar-style'

      /* ── locale ──────────────────────────────────────────────────── */

      const DICT = {
        zh: {
          title: '用量雷达',
          context: '上下文占用',
          input: '输入',
          output: '输出',
          cache: '缓存读取',
          reasoning: '推理',
          todayQuota: '今日额度',
          remaining: '剩余',
          resetIn: '重置',
          live: '实时',
          idle: '空闲',
          streaming: '生成中',
          turns: '轮',
          steps: '步',
          cacheHit: '命中率',
          recentOutput: '最近输出',
          perMinute: '/ 分钟',
          close: '关闭',
          noSession: '打开一个会话后即可读取实时用量',
          detached: '该会话未在本进程加载，仅显示已记录统计',
          waiting: '等待本轮用量数据…',
          cacheTitle: '缓存命中率（会话）',
          cacheWindow: '最近 24 步',
          cacheClean: '最近步骤均已命中缓存',
          unavailable: '暂时读不到用量数据',
        },
        en: {
          title: 'Usage Radar',
          context: 'Context used',
          input: 'Input',
          output: 'Output',
          cache: 'Cache read',
          reasoning: 'Reasoning',
          todayQuota: "Today's budget",
          remaining: 'left',
          resetIn: 'resets in',
          live: 'Live',
          idle: 'Idle',
          streaming: 'Streaming',
          turns: 'turns',
          steps: 'steps',
          cacheHit: 'cache hit',
          recentOutput: 'Recent output',
          perMinute: '/ min',
          close: 'Close',
          noSession: 'Open a session to read live usage',
          detached: 'This session is not loaded in this process; recorded totals only.',
          waiting: 'Waiting for this step’s usage…',
          cacheTitle: 'Cache hit rate (session)',
          cacheWindow: 'Last 24 steps',
          cacheClean: 'Recent steps all hit the cache',
          unavailable: 'Usage is temporarily unavailable',
        },
      }

      let LANG = 'zh'
      let T = DICT.zh

      function detectLocale(ctx) {
        try {
          const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (!locale || typeof locale.getLocale !== 'function') return
          const snap = locale.getLocale()
          const id = String((snap && (snap.id || snap.locale || snap.language || snap.current)) || '')
          if (id) {
            LANG = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
            T = DICT[LANG] || DICT.zh
          }
          if (typeof locale.register === 'function') {
            try {
              locale.register('dsh-usage-radar', 'zh', DICT.zh)
              locale.register('dsh-usage-radar', 'en', DICT.en)
            } catch {
              /* older locale services only accept the typed overload */
            }
          }
        } catch {
          /* locale is a convenience, never a dependency */
        }
      }

      /* ── formatting ──────────────────────────────────────────────── */

      function fmt(value) {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) return '0'
        if (n >= 1e9) return trim(n / 1e9) + 'B'
        if (n >= 1e6) return trim(n / 1e6) + 'M'
        if (n >= 1e3) return trim(n / 1e3) + 'k'
        return String(Math.round(n))
      }

      function trim(n) {
        const fixed = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)
        return fixed.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
      }

      function fmtPct(value) {
        const n = Number(value) || 0
        return n >= 10 ? String(Math.round(n)) : n.toFixed(1)
      }

      function levelOf(pct) {
        const n = Number(pct) || 0
        return n >= 85 ? 'danger' : n >= 60 ? 'warn' : 'ok'
      }

      function clampPct(pct) {
        return Math.max(0, Math.min(100, Number(pct) || 0))
      }

      /* ── store ───────────────────────────────────────────────────── */

      const store = {
        data: null,
        error: null,
        open: false,
        sessionId: '',
        listeners: new Set(),
        emit() {
          for (const listener of Array.from(this.listeners)) {
            try {
              listener()
            } catch {
              /* a subscriber must not break the panel */
            }
          }
        },
        subscribe(listener) {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        },
        setData(data) {
          this.data = data
          this.error = null
          this.emit()
        },
        setError(error) {
          this.error = error
          this.emit()
        },
        openPanel(sessionId) {
          this.sessionId = sessionId || ''
          this.open = true
          this.emit()
        },
        closePanel() {
          this.open = false
          this.emit()
        },
        setSession(sessionId) {
          if (this.sessionId !== sessionId) {
            this.sessionId = sessionId || ''
            this.open = false
            this.emit()
          }
        },
      }

      const anchor = { el: null }
      let uid = 0

      function useGid(prefix) {
        return React.useMemo(() => `${prefix || 'dsr'}-${(uid += 1).toString(36)}`, [])
      }

      function useStore() {
        const [, force] = React.useReducer((x) => x + 1, 0)
        React.useEffect(() => store.subscribe(force), [])
        return store
      }

      function useTween(target, ms) {
        const [value, setValue] = React.useState(Number(target) || 0)
        const current = React.useRef(Number(target) || 0)
        React.useEffect(() => {
          const to = Number(target) || 0
          const from = current.current
          if (from === to || typeof requestAnimationFrame !== 'function') {
            current.current = to
            setValue(to)
            return undefined
          }
          const duration = ms || 480
          const start = performance.now()
          let raf = 0
          const step = (now) => {
            const k = Math.min(1, (now - start) / duration)
            const eased = 1 - Math.pow(1 - k, 3)
            const next = from + (to - from) * eased
            current.current = next
            setValue(next)
            if (k < 1) raf = requestAnimationFrame(step)
            else current.current = to
          }
          raf = requestAnimationFrame(step)
          return () => cancelAnimationFrame(raf)
        }, [target, ms])
        return value
      }

      /* ── polling ─────────────────────────────────────────────────── */

      const poll = { sessionId: '', owners: 0, timer: 0, alive: false, delay: 1200 }

      function pollOnce() {
        if (!poll.alive) return
        const sessionId = poll.sessionId
        const url = `${API}/snapshot?session=${encodeURIComponent(sessionId)}`
        fetch(url, { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            if (!poll.alive) return
            store.setData(data)
            poll.delay = data && data.session && data.session.live ? 450 : 1300
          })
          .catch((error) => {
            if (!poll.alive) return
            store.setError(String((error && error.message) || error))
            poll.delay = 3000
          })
          .then(() => {
            if (!poll.alive) return
            clearTimeout(poll.timer)
            poll.timer = setTimeout(pollOnce, poll.delay)
          })
      }

      function acquire(sessionId) {
        poll.sessionId = sessionId
        poll.owners += 1
        if (!poll.alive) {
          poll.alive = true
          poll.delay = 1200
          clearTimeout(poll.timer)
          pollOnce()
        }
        let released = false
        return () => {
          if (released) return
          released = true
          poll.owners = Math.max(0, poll.owners - 1)
          if (poll.owners === 0) {
            poll.alive = false
            clearTimeout(poll.timer)
            poll.timer = 0
          }
        }
      }

      function stopPolling() {
        poll.alive = false
        poll.owners = 0
        clearTimeout(poll.timer)
        poll.timer = 0
      }

      /* ── styles ──────────────────────────────────────────────────── */

      const CSS = `
.dsr-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:1;font-variant-numeric:tabular-nums;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease;-webkit-appearance:none;appearance:none}
.dsr-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsr-pill.is-open{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dsr-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsr-pill-num{font-weight:600;letter-spacing:-.01em}
.dsr-pill-live{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);animation:dsr-blink 1.5s ease-in-out infinite}

.dsr-lv-ok{--dsr-a:var(--dsw-alias-brand-primary);--dsr-b:var(--dsw-alias-state-success-primary)}
.dsr-lv-warn{--dsr-a:var(--dsw-alias-state-warn-primary);--dsr-b:var(--dsw-alias-state-warn-primary)}
.dsr-lv-danger{--dsr-a:var(--dsw-alias-state-error-primary);--dsr-b:var(--dsw-alias-state-warn-primary)}

.dsr-ring{display:block;overflow:visible}
.dsr-ring-track{stroke:var(--dsw-alias-border-l1)}
.dsr-stop-a{stop-color:var(--dsr-a,var(--dsw-alias-brand-primary))}
.dsr-stop-b{stop-color:var(--dsr-b,var(--dsw-alias-brand-primary))}
.dsr-ring-arc{transition:stroke-dashoffset .6s cubic-bezier(.22,.9,.3,1)}
.dsr-ring-arc.is-live{filter:drop-shadow(0 0 4px var(--dsr-a,var(--dsw-alias-brand-primary)))}

.dsr-layer{position:fixed;z-index:60;pointer-events:none}
.dsr-card{position:relative;pointer-events:auto;box-sizing:border-box;width:356px;max-width:calc(100vw - 20px);padding:14px 15px 12px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 20px 48px -12px rgba(0,0,0,.4),0 2px 8px rgba(0,0,0,.12);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;animation:dsr-in .18s cubic-bezier(.22,.9,.3,1) both;overflow:hidden}
.dsr-card::before{content:'';position:absolute;inset:0;border-radius:inherit;background:radial-gradient(120% 88% at 100% 0%,color-mix(in srgb,var(--dsr-a,transparent) 16%,transparent),transparent 62%);pointer-events:none}
.dsr-card > *{position:relative}

.dsr-top{display:flex;align-items:center;gap:8px}
.dsr-brand{display:inline-flex;align-items:center;gap:7px;min-width:0}
.dsr-title{font-size:12.5px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}
.dsr-top-spacer{flex:1}
.dsr-state{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:10.5px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsr-state.is-live{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.dsr-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsr-state.is-live .dsr-dot{background:var(--dsw-alias-state-success-primary);animation:dsr-blink 1.5s ease-in-out infinite}
.dsr-close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;-webkit-appearance:none;appearance:none}
.dsr-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsr-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.dsr-hero{display:flex;align-items:center;gap:14px;margin-top:12px}
.dsr-hero-left{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none}
.dsr-gauge{position:relative;width:116px;height:116px;display:flex;align-items:center;justify-content:center}
.dsr-gauge-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;pointer-events:none}
.dsr-gauge-num{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1}
.dsr-gauge-unit{font-size:12px;font-weight:600;margin-left:1px;opacity:.65}
.dsr-gauge-label{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dsr-gauge-foot{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsr-hero-right{flex:1;min-width:0;display:flex;flex-direction:column;gap:9px}
.dsr-stat{display:flex;flex-direction:column;gap:3px}
.dsr-stat-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsr-stat-val{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsr-stat-bar{height:3px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsr-stat-fill{height:100%;border-radius:999px;background:var(--dsr-tone,var(--dsw-alias-brand-primary));transition:width .5s cubic-bezier(.22,.9,.3,1)}
.dsr-tone-input{--dsr-tone:var(--dsw-alias-brand-primary)}
.dsr-tone-output{--dsr-tone:var(--dsw-alias-state-success-primary)}
.dsr-tone-cache{--dsr-tone:var(--dsw-alias-state-idle-primary)}
.dsr-tone-reasoning{--dsr-tone:var(--dsw-alias-state-warn-primary)}

.dsr-section{margin-top:12px;padding-top:11px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dsr-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
.dsr-section-title{font-size:10.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dsr-section-val{font-size:11px;font-weight:600}
.dsr-spark{display:block;width:100%;height:56px;overflow:visible}
.dsr-spark-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:2 4;opacity:.7}
.dsr-spark-line{fill:none;stroke:var(--dsr-a,var(--dsw-alias-brand-primary));stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.dsr-spark-dot{fill:var(--dsr-a,var(--dsw-alias-brand-primary))}
.dsr-spark-dot-halo{fill:var(--dsr-a,var(--dsw-alias-brand-primary));opacity:.22}
.dsr-spark-empty{font-size:10.5px;color:var(--dsw-alias-label-secondary);height:56px;display:flex;align-items:center;justify-content:center}

.dsr-quota{display:flex;flex-direction:column;gap:6px}
.dsr-quota-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dsr-quota-val{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.dsr-quota-bar{position:relative;height:7px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsr-quota-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsr-a,var(--dsw-alias-brand-primary)),var(--dsr-b,var(--dsw-alias-state-success-primary)));transition:width .55s cubic-bezier(.22,.9,.3,1)}
.dsr-quota-ticks{position:absolute;inset:0;background-image:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),var(--dsw-alias-bg-overlay) calc(25% - 1px),var(--dsw-alias-bg-overlay) 25%)}
.dsr-quota-foot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}

.dsr-livebar{display:flex;align-items:center;gap:6px;margin-top:10px;padding:6px 9px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsr-livebar .dsr-dot{background:var(--dsw-alias-state-success-primary);animation:dsr-blink 1.5s ease-in-out infinite}
.dsr-livebar-spacer{flex:1}
.dsr-livebar b{font-weight:600;color:var(--dsw-alias-label-primary)}

.dsr-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}
.dsr-chip{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1);font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsr-chip-model{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);max-width:170px;overflow:hidden;text-overflow:ellipsis}
.dsr-note{margin-top:12px;padding:8px 10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dsr-err{color:var(--dsw-alias-state-error-primary)}

.dsr-cache-hit{font-variant-numeric:tabular-nums}
.dsr-cache-window{font-size:10px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dsr-cache-bars{display:flex;align-items:flex-end;gap:2px;height:30px}
.dsr-cache-bar{flex:1;min-width:2px;border-radius:2px 2px 1px 1px;background:var(--dsw-alias-state-success-primary);opacity:.85;transition:height .4s cubic-bezier(.22,.9,.3,1)}
.dsr-cache-bar.is-miss{background:var(--dsw-alias-state-warn-primary)}
.dsr-cache-misses{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsr-cache-misses li{display:flex;gap:8px;align-items:baseline}
.dsr-cache-miss-pct{font-weight:600;color:var(--dsw-alias-state-warn-primary);min-width:40px}
.dsr-cache-clean{margin-top:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
@keyframes dsr-in{from{opacity:0;transform:translateY(-5px) scale(.985)}to{opacity:1;transform:none}}
@keyframes dsr-blink{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dsr-card{animation:none}.dsr-pill-live,.dsr-livebar .dsr-dot,.dsr-state.is-live .dsr-dot{animation:none}}
`

      function installStyles(ctx) {
        if (typeof document === 'undefined') return
        try {
          if (!document.getElementById(STYLE_ID)) {
            const el = document.createElement('style')
            el.id = STYLE_ID
            el.textContent = CSS
            document.head.appendChild(el)
          }
        } catch {
          /* styling is best effort */
        }
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            try {
              const el = document.getElementById(STYLE_ID)
              if (el) el.remove()
            } catch {
              /* ignore */
            }
          })
        }
      }

      /* ── artwork ─────────────────────────────────────────────────── */

      function RadarMark(props) {
        const size = (props && props.size) || 18
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': 'true', style: { display: 'block', flex: 'none' } },
          h('circle', { cx: 32, cy: 34, r: 24, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.28, strokeWidth: 3 }),
          h('circle', { cx: 32, cy: 34, r: 14, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.42, strokeWidth: 3 }),
          h('path', { d: 'M32 34 L32 10 A24 24 0 0 1 53.8 22.4 Z', fill: 'currentColor', fillOpacity: 0.22 }),
          h('circle', { cx: 32, cy: 34, r: 4, fill: 'currentColor' }),
          h('circle', { cx: 53.8, cy: 22.4, r: 4, fill: 'currentColor' }),
        )
      }

      function CloseIcon(props) {
        const size = (props && props.size) || 14
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
          h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
        )
      }

      /* ── data-viz ────────────────────────────────────────────────── */

      function Ring(props) {
        const gid = useGid('dsr-ring')
        const size = props.size || 116
        const stroke = props.stroke || 9
        const pct = clampPct(props.pct)
        const radius = (size - stroke) / 2
        const circumference = 2 * Math.PI * radius
        const offset = circumference * (1 - pct / 100)
        return h(
          'svg',
          {
            className: `dsr-ring dsr-lv-${props.level || 'ok'}`,
            width: size,
            height: size,
            viewBox: `0 0 ${size} ${size}`,
            'aria-hidden': 'true',
          },
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' },
              h('stop', { offset: '0%', className: 'dsr-stop-a' }),
              h('stop', { offset: '100%', className: 'dsr-stop-b' }),
            ),
          ),
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            className: 'dsr-ring-track',
            strokeWidth: stroke,
          }),
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: `url(#${gid})`,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: `${circumference} ${circumference}`,
            strokeDashoffset: offset,
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
            className: `dsr-ring-arc${props.live ? ' is-live' : ''}`,
          }),
        )
      }

      function smoothPath(points) {
        if (!points.length) return ''
        let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`
        for (let i = 1; i < points.length; i += 1) {
          const prev = points[i - 1]
          const next = points[i]
          const midX = (prev[0] + next[0]) / 2
          d += ` C ${midX.toFixed(2)} ${prev[1].toFixed(2)} ${midX.toFixed(2)} ${next[1].toFixed(2)} ${next[0].toFixed(2)} ${next[1].toFixed(2)}`
        }
        return d
      }

      function Sparkline(props) {
        const fillId = useGid('dsr-fill')
        const values = (props.values || []).filter((n) => Number.isFinite(n) && n >= 0)
        if (values.length < 2) {
          return h('div', { className: 'dsr-spark-empty' }, T.waiting)
        }
        const width = 306
        const height = 56
        const padX = 4
        const padY = 7
        const max = Math.max(1, ...values)
        const stepX = (width - padX * 2) / Math.max(1, values.length - 1)
        const points = values.map((value, index) => [
          padX + index * stepX,
          padY + (height - padY * 2) * (1 - value / max),
        ])
        const line = smoothPath(points)
        const last = points[points.length - 1]
        const area = `${line} L ${last[0].toFixed(2)} ${height - padY} L ${points[0][0].toFixed(2)} ${height - padY} Z`
        return h(
          'svg',
          {
            className: 'dsr-spark dsr-lv-' + (props.level || 'ok'),
            viewBox: `0 0 ${width} ${height}`,
            preserveAspectRatio: 'none',
            'aria-hidden': 'true',
          },
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: fillId, x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', className: 'dsr-stop-a', style: { stopOpacity: 0.34 } }),
              h('stop', { offset: '100%', className: 'dsr-stop-a', style: { stopOpacity: 0 } }),
            ),
          ),
          [0.35, 0.68].map((ratio, index) =>
            h('line', {
              key: `grid-${index}`,
              className: 'dsr-spark-grid',
              x1: 0,
              x2: width,
              y1: height * ratio,
              y2: height * ratio,
            }),
          ),
          h('path', { d: area, fill: `url(#${fillId})` }),
          h('path', { d: line, className: 'dsr-spark-line' }),
          h('circle', { cx: last[0], cy: last[1], r: 4.5, className: 'dsr-spark-dot-halo' }),
          h('circle', { cx: last[0], cy: last[1], r: 2.2, className: 'dsr-spark-dot' }),
        )
      }

      function StatRow(props) {
        const width = props.max > 0 ? Math.max(2, Math.min(100, (Number(props.value) / props.max) * 100)) : 0
        return h(
          'div',
          { className: 'dsr-stat' },
          h(
            'div',
            { className: 'dsr-stat-top' },
            h('span', { className: 'dsr-stat-label' }, props.label),
            h('span', { className: 'dsr-stat-val' }, fmt(props.value)),
          ),
          h(
            'div',
            { className: 'dsr-stat-bar' },
            h('div', { className: `dsr-stat-fill ${props.tone || ''}`, style: { width: `${width}%` } }),
          ),
        )
      }

      /* ── pill ────────────────────────────────────────────────────── */

      function resolveSessionId(props) {
        if (props && typeof props.sessionId === 'string' && props.sessionId) return props.sessionId
        try {
          if (props && typeof props.useSession === 'function') {
            const fromSelector = props.useSession((snapshot) => snapshot && snapshot.sessionId)
            if (typeof fromSelector === 'string' && fromSelector) return fromSelector
          }
        } catch {
          /* hook shape differs */
        }
        return ''
      }

      function Pill(props) {
        const sessionId = resolveSessionId(props)
        const state = useStore()
        const data = state.data
        const session = (data && data.session) || null
        const pct = session ? clampPct(session.contextPct) : 0
        const level = levelOf(pct)
        const live = Boolean(session && session.live)
        const shown = useTween(pct, 600)

        React.useEffect(() => {
          if (!sessionId) return undefined
          store.setSession(sessionId)
          return acquire(sessionId)
        }, [sessionId])

        const tip = session
          ? `${T.title} · ${T.context} ${fmtPct(pct)}% · ${fmt(session.contextUsed)}/${fmt(session.contextWindow)}`
          : T.title

        return h(
          'button',
          {
            type: 'button',
            className: `dsr-pill${state.open ? ' is-open' : ''} dsr-lv-${level}`,
            title: tip,
            'aria-label': tip,
            'aria-haspopup': 'dialog',
            'aria-expanded': state.open ? 'true' : 'false',
            onClick: (event) => {
              anchor.el = event.currentTarget
              if (state.open) store.closePanel()
              else store.openPanel(sessionId)
            },
          },
          h(Ring, { pct: shown, size: 18, stroke: 2.6, level, live }),
          h('span', { className: 'dsr-pill-num' }, `${fmtPct(pct)}%`),
          live ? h('span', { className: 'dsr-pill-live', 'aria-hidden': 'true' }) : null,
        )
      }

      /* ── panel ───────────────────────────────────────────────────── */

      function positionFor(element) {
        if (!element || typeof window === 'undefined') return { right: 16, top: 64 }
        const rect = element.getBoundingClientRect()
        const right = Math.max(10, Math.round(window.innerWidth - rect.right))
        const below = Math.round(rect.bottom + 10)
        const estimated = 430
        if (below + estimated > window.innerHeight && rect.top > estimated) {
          return { right, bottom: Math.round(window.innerHeight - rect.top + 10) }
        }
        return { right, top: below }
      }

      /* ── cache observation (read-only) ───────────────────────────── */

      const CAUSE_TEXT = {
        zh: {
          cold: '首次请求，尚无缓存',
          'model-switch': '切换了模型/provider',
          'new-input': '本步新增大段输入',
          'prefix-changed': '前缀发生变化，缓存重建',
          unknown: '原因未知',
        },
        en: {
          cold: 'First request, nothing cached yet',
          'model-switch': 'Model or provider switched',
          'new-input': 'Large new input this step',
          'prefix-changed': 'Prefix changed, cache rebuilt',
          unknown: 'Cause unknown',
        },
      }

      function CacheSection(props) {
        const cache = props.cache
        if (!cache || !Array.isArray(cache.steps) || cache.steps.length === 0) return null
        const causes = CAUSE_TEXT[LANG] || CAUSE_TEXT.zh
        const steps = cache.steps.slice(-24)
        const misses = (cache.misses || []).slice(-3).reverse()
        const hit = clampPct(cache.hitPct)
        return h(
          'div',
          { className: 'dsr-section dsr-cache', key: 'cache' },
          h(
            'div',
            { className: 'dsr-section-head' },
            h('span', { className: 'dsr-section-title' }, T.cacheTitle),
            h('span', { className: `dsr-section-val dsr-cache-hit dsr-lv-${levelOf(100 - hit)}` }, `${fmtPct(hit)}%`),
          ),
          h('div', { className: 'dsr-cache-window' }, T.cacheWindow),
          h(
            'div',
            { className: 'dsr-cache-bars', 'aria-hidden': 'true' },
            steps.map((step, index) =>
              h('span', {
                key: `s-${index}`,
                className: `dsr-cache-bar${step.cause ? ' is-miss' : ''}`,
                title: `${fmtPct(step.hitPct)}%`,
                style: { height: `${Math.max(12, clampPct(step.hitPct))}%` },
              }),
            ),
          ),
          misses.length
            ? h(
                'ul',
                { className: 'dsr-cache-misses' },
                misses.map((miss, index) =>
                  h(
                    'li',
                    { key: `m-${index}` },
                    h('span', { className: 'dsr-cache-miss-pct' }, `${fmtPct(miss.hitPct)}%`),
                    h('span', null, causes[miss.cause] || causes.unknown),
                  ),
                ),
              )
            : h('div', { className: 'dsr-cache-clean' }, T.cacheClean),
        )
      }

      function Panel() {
        const state = useStore()
        const data = state.data
        const session = (data && data.session) || null
        const day = (data && data.day) || null
        const level = session ? levelOf(session.contextPct) : 'ok'
        const [pos, setPos] = React.useState(() => positionFor(anchor.el))
        const [, setClock] = React.useState(0)

        React.useEffect(() => {
          if (!state.open) return undefined
          setPos(positionFor(anchor.el))
          const update = () => setPos(positionFor(anchor.el))
          const onKey = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              store.closePanel()
            }
          }
          const onPointer = (event) => {
            const target = event.target
            try {
              if (target && target.closest && target.closest('.dsr-card, .dsr-pill')) return
            } catch {
              /* ignore */
            }
            store.closePanel()
          }
          const timer = setInterval(() => setClock((x) => x + 1), 30000)
          window.addEventListener('resize', update)
          window.addEventListener('scroll', update, true)
          document.addEventListener('keydown', onKey, true)
          document.addEventListener('pointerdown', onPointer, true)
          return () => {
            clearInterval(timer)
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
            document.removeEventListener('keydown', onKey, true)
            document.removeEventListener('pointerdown', onPointer, true)
          }
        }, [state.open])

        const pct = session ? clampPct(session.contextPct) : 0
        const shownPct = useTween(pct, 550)

        if (!state.open) return null

        const quotaPct = day ? clampPct(day.pct) : 0
        const values = ((session && session.spark) || []).map((sample) => Number(sample.o) || 0)
        const maxStat = session
          ? Math.max(1, session.input, session.output, session.cacheRead, session.reasoning)
          : 1
        const resetText = day && day.resetAt ? countdown(day.resetAt) : '—'

        const body = session
          ? [
              h(
                'div',
                { className: 'dsr-hero', key: 'hero' },
                h(
                  'div',
                  { className: 'dsr-hero-left' },
                  h(
                    'div',
                    { className: 'dsr-gauge' },
                    h(Ring, { pct: shownPct, size: 116, stroke: 9, level, live: Boolean(session.live) }),
                    h(
                      'div',
                      { className: 'dsr-gauge-center' },
                      h(
                        'div',
                        { className: 'dsr-gauge-num' },
                        fmtPct(shownPct),
                        h('span', { className: 'dsr-gauge-unit' }, '%'),
                      ),
                      h('div', { className: 'dsr-gauge-label' }, T.context),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dsr-gauge-foot' },
                    `${fmt(session.contextUsed)} / ${fmt(session.contextWindow)}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'dsr-hero-right' },
                  h(StatRow, {
                    label: T.input,
                    value: session.input,
                    max: maxStat,
                    tone: 'dsr-tone-input',
                  }),
                  h(StatRow, {
                    label: T.output,
                    value: session.output,
                    max: maxStat,
                    tone: 'dsr-tone-output',
                  }),
                  h(StatRow, {
                    label: T.cache,
                    value: session.cacheRead,
                    max: maxStat,
                    tone: 'dsr-tone-cache',
                  }),
                  h(StatRow, {
                    label: T.reasoning,
                    value: session.reasoning,
                    max: maxStat,
                    tone: 'dsr-tone-reasoning',
                  }),
                ),
              ),
              h(
                'div',
                { className: 'dsr-section', key: 'spark' },
                h(
                  'div',
                  { className: 'dsr-section-head' },
                  h('span', { className: 'dsr-section-title' }, T.recentOutput),
                  h(
                    'span',
                    { className: 'dsr-section-val' },
                    `${fmt(session.minuteOut)} ${T.perMinute}`,
                  ),
                ),
                h(Sparkline, { values, level }),
              ),
              h(CacheSection, { cache: session.cache, key: 'cache' }),
              h(
                'div',
                { className: 'dsr-section dsr-quota', key: 'quota' },
                h(
                  'div',
                  { className: 'dsr-quota-top' },
                  h('span', { className: 'dsr-section-title' }, T.todayQuota),
                  h(
                    'span',
                    { className: 'dsr-quota-val' },
                    `${fmt(day && day.used)} / ${fmt(day && day.budget)}`,
                  ),
                ),
                h(
                  'div',
                  { className: `dsr-quota-bar dsr-lv-${levelOf(quotaPct)}` },
                  h('div', { className: 'dsr-quota-fill', style: { width: `${quotaPct}%` } }),
                  h('div', { className: 'dsr-quota-ticks', 'aria-hidden': 'true' }),
                ),
                h(
                  'div',
                  { className: 'dsr-quota-foot' },
                  h('span', null, `${T.remaining} ${fmt(day && day.remaining)}`),
                  h('span', null, `${T.resetIn} ${resetText}`),
                ),
              ),
              session.live
                ? h(
                    'div',
                    { className: 'dsr-livebar', key: 'live' },
                    h('span', { className: 'dsr-dot', 'aria-hidden': 'true' }),
                    h('span', null, T.streaming),
                    h('span', { className: 'dsr-livebar-spacer' }),
                    h('b', null, `${fmt(session.minuteOut)} tok`),
                    h('span', null, T.perMinute),
                  )
                : session.attached
                  ? null
                  : h('div', { className: 'dsr-note', key: 'detached' }, T.detached),
              h(
                'div',
                { className: 'dsr-meta', key: 'meta' },
                h('span', { className: 'dsr-chip' }, `${session.turns || 0} ${T.turns}`),
                h('span', { className: 'dsr-chip' }, `${session.steps || 0} ${T.steps}`),
                h('span', { className: 'dsr-chip' }, `${T.cacheHit} ${fmtPct(session.cacheHitPct)}%`),
                session.model
                  ? h('span', { className: 'dsr-chip dsr-chip-model', title: session.model }, session.model)
                  : null,
              ),
            ]
          : [h('div', { className: 'dsr-note', key: 'note' }, state.sessionId ? T.unavailable : T.noSession)]

        return h(
          'div',
          { className: 'dsr-layer', style: pos, 'data-dsr-ui': 'panel' },
          h(
            'div',
            {
              className: `dsr-card dsr-lv-${level}`,
              role: 'dialog',
              'aria-label': T.title,
              'aria-modal': 'false',
            },
            h(
              'div',
              { className: 'dsr-top' },
              h(
                'span',
                { className: 'dsr-brand' },
                h(RadarMark, { size: 17 }),
                h('span', { className: 'dsr-title' }, T.title),
              ),
              h('span', { className: 'dsr-top-spacer' }),
              h(
                'span',
                { className: `dsr-state${session && session.live ? ' is-live' : ''}` },
                h('span', { className: 'dsr-dot', 'aria-hidden': 'true' }),
                session && session.live ? T.live : T.idle,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsr-close',
                  onClick: () => store.closePanel(),
                  'aria-label': T.close,
                  title: T.close,
                },
                h(CloseIcon, { size: 13 }),
              ),
            ),
            body,
            state.error
              ? h('div', { className: 'dsr-note dsr-err' }, state.error)
              : null,
          ),
        )
      }

      function countdown(target) {
        const ms = Math.max(0, Number(target) - Date.now())
        const hours = Math.floor(ms / 3600000)
        const minutes = Math.floor((ms % 3600000) / 60000)
        if (hours > 0 || minutes > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
        return `${Math.max(0, Math.floor(ms / 1000))}s`
      }

      /* ── fault isolation ─────────────────────────────────────────── */

      class Boundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }
        static getDerivedStateFromError() {
          return { failed: true }
        }
        componentDidCatch(error) {
          try {
            console.warn('[用量雷达] 组件渲染失败，已降级：', (error && error.message) || error)
          } catch {
            /* ignore */
          }
        }
        render() {
          return this.state.failed ? null : this.props.children
        }
      }

      function guarded(Inner) {
        return function Guarded(props) {
          return h(Boundary, null, h(Inner, props))
        }
      }

      const SafePill = guarded(Pill)
      const SafePanel = guarded(Panel)

      /* ── apply ───────────────────────────────────────────────────── */

      function apply(ctx) {
        try {
          detectLocale(ctx)
          installStyles(ctx)
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
            console.warn('[用量雷达] 宿主没有 slots 服务，已跳过界面注册')
            return
          }
          const attempt = (label, register) => {
            try {
              register()
            } catch (error) {
              console.warn(`[用量雷达] 插槽注册失败（已跳过 ${label}）：`, (error && error.message) || error)
            }
          }
          attempt('标题栏仪表', () =>
            ctx.slots.inject(PILL_SLOT, () =>
              ctx.slots.register({ name: PILL_SLOT, id: 'usage-radar', order: 6 }, SafePill),
            ),
          )
          attempt('雷达面板', () =>
            ctx.slots.inject(OVERLAY_SLOT, () =>
              ctx.slots.register({ name: OVERLAY_SLOT, id: 'usage-radar/panel', order: 40 }, SafePanel),
            ),
          )
          if (typeof ctx.effect === 'function') ctx.effect(() => () => stopPolling())
        } catch (error) {
          console.warn('[用量雷达] 客户层加载失败（已降级为空插件）：', (error && error.message) || error)
        }
      }

      return { inject: ['slots'], apply }
    } catch (error) {
      try {
        console.warn('[用量雷达] 客户层加载失败（已降级为空插件）：', (error && error.message) || error)
      } catch {
        /* ignore */
      }
      return { inject: [], apply() {} }
    }
  },
})
