// Starts a race from the terminal and prints the results.
//   node scripts/race.mjs [--coordinator URL] [--by lang|machine|worker|all]
//                         [--size 1920x1080] [--iter 4096] [--tile 64] [--preset overview]
//                         [--lang rust]   only workers of this language

import { parseArgs } from 'node:util'

const PRESETS = {
  overview: { centerX: -0.5, centerY: 0, span: 3.2 },
  seahorse: { centerX: -0.743643887037151, centerY: 0.13182590420533, span: 0.0006 },
  minibrot: { centerX: -1.768778833, centerY: -0.001738996, span: 0.00000008 },
}

const { values: opts } = parseArgs({
  options: {
    coordinator: { type: 'string', default: 'http://100.64.0.1:8787' },
    by: { type: 'string', default: 'lang' },
    size: { type: 'string', default: '1920x1080' },
    iter: { type: 'string', default: '4096' },
    tile: { type: 'string', default: '64' },
    preset: { type: 'string', default: 'overview' },
    lang: { type: 'string' },
  },
})
const base = opts.coordinator.replace(/\/+$/, '')
const [width, height] = opts.size.split('x').map(Number)
const view = PRESETS[opts.preset]
if (!view) throw new Error(`unknown preset ${opts.preset}`)

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws')
let started = false
let raceId // the coordinator also replays the previous race on connect: ignore it
const races = new Map()
const threads = new Map() // worker id -> threads
const finished = new Map() // jobId -> final progress message

ws.onmessage = async (e) => {
  if (typeof e.data !== 'string') return
  const msg = JSON.parse(e.data)
  if (msg.type === 'workers' && !started) {
    started = true
    await start(msg.workers.filter((w) => w.online && (!opts.lang || w.lang === opts.lang)))
  } else if (msg.type === 'race') {
    races.set(msg.race.id, msg.race)
  } else if (msg.type === 'progress' && msg.finished) {
    finished.set(msg.jobId, msg)
  }
  check()
}

// The race announcement can arrive before the HTTP response that names it.
function check() {
  const race = races.get(raceId)
  if (race && race.lanes.every((l) => finished.has(l.jobId))) report(race)
}

async function start(workers) {
  if (workers.length === 0) throw new Error('no worker online')
  for (const w of workers) threads.set(w.id, w.threads)
  const key = { lang: (w) => w.lang, machine: (w) => w.machine, worker: (w) => w.id, all: () => 'all' }[opts.by]
  if (!key) throw new Error(`--by must be lang, machine, worker or all`)
  const groups = Map.groupBy(workers, key)
  const lanes = [...groups].map(([label, ws]) => ({ label, workers: ws.map((w) => w.id) }))
  const res = await fetch(`${base}/api/races`, {
    method: 'POST',
    body: JSON.stringify({
      width,
      height,
      tileSize: Number(opts.tile),
      params: { centerX: view.centerX, centerY: view.centerY, scale: view.span / width, maxIter: Number(opts.iter) },
      lanes,
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  raceId = (await res.json()).raceId
  check()
  console.log(`race: ${opts.size}, ${opts.iter} iterations, ${opts.preset}, lanes by ${opts.by}`)
}

function report(race) {
  const rows = race.lanes
    .map((l) => [l.label, finished.get(l.jobId)])
    .sort((a, b) => a[1].elapsedMs - b[1].elapsedMs)
    .map(([label, p], i) => {
      const stats = Object.entries(p.stats)
      const pixels = stats.reduce((s, [, w]) => s + w.pixels, 0)
      // Wall time if every thread computed back to back with zero network or queueing.
      const laneThreads = stats.reduce((s, [id]) => s + (threads.get(id) ?? 1), 0)
      const computeMs = stats.reduce((s, [, w]) => s + w.computeNs / 1e6, 0) / laneThreads
      return {
        rank: i + 1,
        lane: label,
        time: `${(p.elapsedMs / 1000).toFixed(2)} s`,
        'Mpx/s': (pixels / p.elapsedMs / 1000).toFixed(1),
        compute: `${Math.round((computeMs / p.elapsedMs) * 100)} %`,
        'first tile': `${p.firstTileMs.toFixed(0)} ms`,
        requeued: p.requeued,
        mismatches: p.mismatches,
      }
    })
  console.table(rows)
  ws.close()
  process.exit(rows.some((r) => r.mismatches > 0) ? 1 : 0)
}

setTimeout(() => {
  console.error('timed out after 10 minutes')
  process.exit(2)
}, 600_000)
