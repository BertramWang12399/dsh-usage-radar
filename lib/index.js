/**
 * dsh-usage-radar — Host half.
 *
 * Aggregates live token usage and the day's quota from committed Session events
 * and the live assistant stream, then serves one small JSON snapshot to the
 * Client half over a package-scoped HTTP prefix. Nothing here is model-facing.
 *
 * Contract (see README):
 *   GET {ROUTE}/api/health                        -> liveness probe
 *   GET {ROUTE}/api/snapshot?session=<sessionId>  -> the snapshot the panel draws
 */

export const name = 'dsh-usage-radar'

/** `agents` + `webServer` are the only hard requirements; tokenMeter stays optional. */
export const inject = ['agents', 'webServer']

const ROUTE = '/dsh-usage-radar'
const VERSION = 1

const DEFAULTS = {
  /** Tokens of input+output per local day counted as 100% of the personal budget. */
  dailyBudget: 2000000,
  /** How many per-step samples the sparkline keeps. */
  sampleLimit: 48,
  /** Cache window for the (O(surface)) tokenMeter reprice. */
  measureTtlMs: 2500,
}

const MINUTE = 60 * 1000

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function nextMidnight(ts) {
  const d = new Date(ts)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

function dayKey(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Cache hit rate, in the same definition the composer stats strip uses:
 *   cacheRead / (cacheRead + input + cacheWrite)
 * Cache writes count in the denominator: they are tokens we paid to store, not
 * tokens served from cache. Leaving them out overstates the hit rate.
 */
function hitRate(cacheRead, input, cacheWrite) {
  const denom = positive(cacheRead) + positive(input) + positive(cacheWrite)
  return denom > 0 ? Math.round((positive(cacheRead) / denom) * 1000) / 10 : 0
}

function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, steps: 0 }
}

function normUsage(usage) {
  const input = positive(usage.inputTokens)
  const output = positive(usage.outputTokens)
  // Accounting口径: the budget tracks freshly paid tokens (prompt + completion).
  // Provider `totalTokens` also folds in cache reads, which would swamp the quota
  // on any cache-heavy session, so it is deliberately not used here.
  return {
    input,
    output,
    total: input + output,
    cacheRead: positive(usage.cacheReadTokens),
    cacheWrite: positive(usage.cacheWriteTokens),
    reasoning: positive(usage.reasoningTokens),
  }
}

function addUsage(acc, normalized) {
  acc.input += normalized.input
  acc.output += normalized.output
  acc.cacheRead += normalized.cacheRead
  acc.cacheWrite += normalized.cacheWrite
  acc.reasoning += normalized.reasoning
  acc.total += normalized.total
  acc.steps += 1
  return acc
}

function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export function apply(ctx, config) {
  const options = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  const sampleLimit = Math.max(8, Math.min(240, Number(options.sampleLimit) || DEFAULTS.sampleLimit))
  const measureTtlMs = Math.max(500, Number(options.measureTtlMs) || DEFAULTS.measureTtlMs)

  /** @type {Map<string, any>} */
  const sessions = new Map()

  const day = {
    key: dayKey(Date.now()),
    usage: emptyUsage(),
    seeded: false,
    /** sessionId -> highest seq already counted while seeding */
    floor: new Map(),
  }

  /* ── live state ─────────────────────────────────────────────────── */

  function ensureSession(id) {
    let state = sessions.get(id)
    if (!state) {
      state = {
        id,
        usage: emptyUsage(),
        turns: 0,
        running: false,
        spark: [],
        cacheSteps: [],
        lastModelKey: '',
        lastUsage: null,
        lastEventAt: 0,
        liveUsage: null,
        liveAt: 0,
        seeded: false,
        floorSeq: -1,
        measureAt: 0,
        measureValue: null,
      }
      sessions.set(id, state)
    }
    return state
  }

  function pushSpark(state, time, usage) {
    state.spark.push({ t: time, o: usage.output, i: usage.input })
    if (state.spark.length > sampleLimit) state.spark.splice(0, state.spark.length - sampleLimit)
  }

  /* ── cache observation (read-only: never touches the request) ───── */

  const CACHE_MISS_BELOW = 60
  const CACHE_BIG_INPUT = 4000

  /**
   * Record one assistant step's prompt-cache outcome and classify misses.
   * Pure observation: it reads the usage that the provider already reported.
   */
  function pushCacheStep(state, event, usage, provider, model) {
    const cacheRead = usage.cacheRead
    const input = usage.input
    const cacheWrite = usage.cacheWrite
    const prefix = cacheRead + input + cacheWrite
    const hitPct = hitRate(cacheRead, input, cacheWrite)
    const key = `${provider}/${model}`

    let cause = null
    if (prefix > 0 && hitPct < CACHE_MISS_BELOW) {
      if (state.cacheSteps.length === 0) cause = 'cold'
      else if (state.lastModelKey && state.lastModelKey !== key) cause = 'model-switch'
      else if (input >= CACHE_BIG_INPUT) cause = 'new-input'
      else if (cacheWrite > 0 && cacheRead === 0) cause = 'prefix-changed'
      else cause = 'unknown'
    }

    state.lastModelKey = key
    state.cacheSteps.push({
      seq: Number(event.seq) || 0,
      t: positive(event.time) || Date.now(),
      hitPct,
      cacheRead,
      input,
      cacheWrite,
      cause,
    })
    if (state.cacheSteps.length > sampleLimit) {
      state.cacheSteps.splice(0, state.cacheSteps.length - sampleLimit)
    }
  }

  /** Provider/model that produced this step: the message source first, the request context second. */
  function modelOf(event, session) {
    const source = safe(() => event.data.message.source, null)
    if (source && typeof source.model === 'string') {
      return [String(source.provider || ''), String(source.model)]
    }
    const info = safe(() => session.requestContext(), null) || {}
    return [String(info.provider || ''), String(info.model || '')]
  }

  function cacheSummary(state) {
    const steps = state.cacheSteps
    let read = 0
    let fresh = 0
    let written = 0
    for (const step of steps) {
      read += step.cacheRead
      fresh += step.input
      written += step.cacheWrite
    }
    const misses = steps.filter((step) => step.cause).slice(-8)
    return {
      // Window figure: the last N steps only. Labelled separately in the UI.
      hitPct: hitRate(read, fresh, written),
      steps: steps.slice(-48),
      misses,
    }
  }

  function liveAgent(sessionId) {
    return safe(() => (ctx.agents ? ctx.agents.get(sessionId) : undefined), undefined)
  }

  /* ── day budget seed: every live Session log, once per day ───────── */

  function seedDay() {
    day.seeded = true
    day.floor.clear()
    const from = startOfDay(Date.now())
    const agents = safe(() => (ctx.agents ? ctx.agents.list() : []), []) || []
    for (const agent of agents) {
      const session = agent && agent.session
      if (!session || typeof session.ownEvents !== 'function') continue
      const id = String(session.id)
      let top = -1
      safe(() => {
        for (const event of session.ownEvents()) {
          const seq = Number(event.seq) || 0
          if (seq > top) top = seq
          if (event.type !== 'assistant/message') continue
          if (positive(event.time) < from) continue
          const usage = event.data && event.data.usage
          if (!usage) continue
          addUsage(day.usage, normUsage(usage))
        }
      }, null)
      day.floor.set(id, top)
    }
  }

  function ensureDay() {
    const key = dayKey(Date.now())
    if (day.key !== key) {
      day.key = key
      day.usage = emptyUsage()
      day.seeded = false
      day.floor.clear()
    }
    if (!day.seeded) seedDay()
    return day
  }

  /* ── session fold seed ──────────────────────────────────────────── */

  function seedSession(state, session) {
    state.seeded = true
    let top = -1
    safe(() => {
      for (const event of session.ownEvents()) {
        const seq = Number(event.seq) || 0
        if (seq > top) top = seq
        if (event.type === 'turn/start') state.turns += 1
        if (event.type !== 'assistant/message') continue
        const usage = event.data && event.data.usage
        if (!usage) continue
        const normalized = normUsage(usage)
        addUsage(state.usage, normalized)
        pushSpark(state, positive(event.time) || Date.now(), normalized)
        pushCacheStep(state, event, normalized, ...modelOf(event, session))
        state.lastUsage = normalized
      }
    }, null)
    state.floorSeq = top
  }

  /* ── event subscriptions ────────────────────────────────────────── */

  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const id = String(session.id)
      ensureDay()
      const state = ensureSession(id)
      if (!state.seeded) seedSession(state, session)
      state.lastEventAt = Date.now()

      if (event.type === 'turn/start') {
        state.turns += 1
        return
      }
      if (event.type !== 'assistant/message') return

      const seq = Number(event.seq) || 0
      const usage = event.data && event.data.usage
      if (!usage) return
      const normalized = normUsage(usage)

      if (seq > state.floorSeq) {
        addUsage(state.usage, normalized)
        pushSpark(state, positive(event.time) || Date.now(), normalized)
        pushCacheStep(state, event, normalized, ...modelOf(event, session))
        state.lastUsage = normalized
        const floor = day.floor.has(id) ? day.floor.get(id) : -1
        if (seq > floor) {
          addUsage(day.usage, normalized)
          day.floor.set(id, seq)
        }
      }
    } catch {
      /* a monitor must never disturb the session */
    }
  })

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const frame = payload && payload.frame
      if (!frame || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (!chunk || chunk.type !== 'usage' || !chunk.usage) return
      const id = String(payload.agent && payload.agent.id)
      if (!id) return
      const state = ensureSession(id)
      state.liveUsage = normUsage(chunk.usage)
      state.liveAt = Date.now()
      state.running = true
    } catch {
      /* ignore */
    }
  })

  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const state = ensureSession(String(agent.id))
      state.running = payload.status === 'running'
      if (!state.running) state.liveUsage = null
    } catch {
      /* ignore */
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const id = String(payload && payload.agent && payload.agent.id)
      const state = id ? sessions.get(id) : undefined
      if (state) {
        state.running = false
        state.liveUsage = null
      }
    } catch {
      /* ignore */
    }
  })

  /* ── snapshot ───────────────────────────────────────────────────── */

  function contextWindowOf(session) {
    return positive(safe(() => session.requestContext().contextWindow, 0))
  }

  function metaOf(session) {
    const info = safe(() => session.requestContext(), null) || {}
    return {
      provider: typeof info.provider === 'string' ? info.provider : '',
      model: typeof info.model === 'string' ? info.model : '',
    }
  }

  function measureOf(state, session) {
    const meter = safe(() => ctx.get('tokenMeter'), undefined)
    if (!meter || typeof meter.measure !== 'function' || !session) return null
    const now = Date.now()
    if (state.measureAt > 0 && now - state.measureAt < measureTtlMs) return state.measureValue
    const measurement = safe(() => meter.measure(session), null)
    state.measureAt = now
    state.measureValue = measurement && Number.isFinite(measurement.totalTokens) ? measurement.totalTokens : null
    return state.measureValue
  }

  function minuteUsage(state) {
    const now = Date.now()
    let out = 0
    let inp = 0
    for (let i = state.spark.length - 1; i >= 0; i -= 1) {
      const sample = state.spark[i]
      if (now - sample.t > MINUTE) break
      out += sample.o
      inp += sample.i
    }
    return { out, in: inp }
  }

  function buildSnapshot(sessionId) {
    const current = ensureDay()
    const state = ensureSession(sessionId || '')
    const agent = sessionId ? liveAgent(sessionId) : undefined
    const session = agent && agent.session ? agent.session : null

    if (session && !state.seeded) seedSession(state, session)

    const contextWindow = session ? contextWindowOf(session) : 0
    const meta = session ? metaOf(session) : { provider: '', model: '' }
    const measured = measureOf(state, session)
    const fallbackUsed = state.lastUsage ? state.lastUsage.input + state.lastUsage.output : 0
    const contextUsed = measured !== null ? measured : fallbackUsed
    const pct = contextWindow > 0 ? Math.min(100, (contextUsed / contextWindow) * 100) : 0

    const usage = state.usage

    const budget = Math.max(1, positive(Number(options.dailyBudget)) || DEFAULTS.dailyBudget)
    const used = current.usage.total
    const minute = minuteUsage(state)

    return {
      ok: true,
      v: VERSION,
      t: Date.now(),
      day: {
        key: current.key,
        used,
        budget,
        remaining: Math.max(0, budget - used),
        pct: Math.min(100, (used / budget) * 100),
        resetAt: nextMidnight(Date.now()),
        input: current.usage.input,
        output: current.usage.output,
        sessions: current.floor.size,
      },
      session: {
        id: sessionId || '',
        live: Boolean(state.running),
        attached: Boolean(session),
        provider: meta.provider,
        model: meta.model,
        contextWindow,
        contextUsed,
        contextPct: Math.round(pct * 10) / 10,
        contextSource: measured !== null ? 'meter' : fallbackUsed > 0 ? 'usage' : 'none',
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning,
        total: usage.total,
        steps: usage.steps,
        turns: state.turns,
        cacheHitPct: hitRate(usage.cacheRead, usage.input, usage.cacheWrite),
        minuteOut: minute.out,
        minuteIn: minute.in,
        spark: state.spark.slice(-sampleLimit),
        cache: cacheSummary(state),
        lastUsage: state.lastUsage,
        streaming: state.liveUsage && Date.now() - state.liveAt < 15000 ? state.liveUsage : null,
      },
    }
  }

  /* ── HTTP surface ───────────────────────────────────────────────── */

  /** Snapshot requests served — a cheap "is the panel actually running" signal. */
  let served = 0

  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      if (req.method === 'GET' && path === `${ROUTE}/api/health`) {
        return send(res, 200, {
          ok: true,
          v: VERSION,
          sessions: sessions.size,
          agents: safe(() => (ctx.agents ? ctx.agents.list().length : 0), 0),
          served,
        })
      }
      if (req.method === 'GET' && path === `${ROUTE}/api/snapshot`) {
        served += 1
        const sessionId = url.searchParams.get('session') || ''
        return send(res, 200, buildSnapshot(sessionId))
      }
      return send(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      return send(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  const register = () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler })
  if (typeof ctx.effect === 'function') ctx.effect(register)
  else register()
}
