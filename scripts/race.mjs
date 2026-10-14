// Starts a race from the terminal and prints the results.
//   node scripts/race.mjs [--coordinator URL] [--by lang|machine|worker|all]
//                         [--size 1920x1080] [--iter 4096] [--tile 64] [--preset overview]
//                         [--lang rust]   only workers of this language
//                         [--machine pc]  only workers of this machine
//                         [--kind pathtrace --scene marbles|trio --spp 16]
//                         [--sequential]  one lane at a time, so lanes sharing a
//                                         machine don't compete for its cores

import { createHash } from 'node:crypto'
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
    machine: { type: 'string' },
    kind: { type: 'string', default: 'mandelbrot' },
    scene: { type: 'string', default: 'marbles' },
    spp: { type: 'string', default: '16' },
    sequential: { type: 'boolean', default: false },
  },
})
const base = opts.coordinator.replace(/\/+$/, '')
const [width, height] = opts.size.split('x').map(Number)
const view = PRESETS[opts.preset]
if (!view) throw new Error(`unknown preset ${opts.preset}`)

const races = new Map() // race id -> race announcement
const finished = new Map() // job id -> final progress message
const tileHashes = new Map() // job id -> Map(tile id -> sha1), to compare lanes across races
let onUpdate = () => {}

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws')
ws.binaryType = 'arraybuffer'
const workersReady = new Promise((resolve) => {
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      const head = new DataView(e.data, 0, 12)
      const jobId = head.getUint32(0, true)
      if (!tileHashes.has(jobId)) tileHashes.set(jobId, new Map())
      const hash = createHash('sha1').update(new Uint8Array(e.data, 12)).digest('hex')
      tileHashes.get(jobId).set(head.getUint32(4, true), hash)
      return
    }
    const msg = JSON.parse(e.data)
    if (msg.type === 'workers') resolve(msg.workers)
    else if (msg.type === 'race') races.set(msg.race.id, msg.race)
    else if (msg.type === 'progress' && msg.finished) finished.set(msg.jobId, msg)
    onUpdate()
  }
})

const workers = (await workersReady).filter(
  (w) => w.online && (!opts.lang || w.lang === opts.lang) && (!opts.machine || w.machine === opts.machine),
)
if (workers.length === 0) throw new Error('no matching worker online')
const threads = new Map(workers.map((w) => [w.id, w.threads]))
const key = { lang: (w) => w.lang, machine: (w) => w.machine, worker: (w) => w.id, all: () => 'all' }[opts.by]
if (!key) throw new Error('--by must be lang, machine, worker or all')
const lanes = [...Map.groupBy(workers, key)].map(([label, ws]) => ({ label, workers: ws.map((w) => w.id) }))

console.log(
  `${opts.sequential ? 'sequential race' : 'race'}: ${opts.size}, ` +
    (opts.kind === 'pathtrace'
      ? `path tracer "${opts.scene}", ${opts.spp} spp`
      : `${opts.iter} iterations, ${opts.preset}`) +
    `, tile ${opts.tile}, lanes by ${opts.by}`,
)

const results = [] // [{ label, progress }]
for (const batch of opts.sequential ? lanes.map((l) => [l]) : [lanes]) {
  const race = await runRace(batch)
  for (const lane of race.lanes) results.push({ label: lane.label, jobId: lane.jobId, progress: finished.get(lane.jobId) })
}
report(results)

async function runRace(raceLanes) {
  const res = await fetch(`${base}/api/races`, {
    method: 'POST',
    body: JSON.stringify({
      width,
      height,
      tileSize: Number(opts.tile),
      lanes: raceLanes,
      ...(opts.kind === 'pathtrace'
        ? { kind: 'pathtrace', pathTrace: { preset: opts.scene, spp: Number(opts.spp), maxDepth: 10 } }
        : {
            kind: 'mandelbrot',
            params: { centerX: view.centerX, centerY: view.centerY, scale: view.span / width, maxIter: Number(opts.iter) },
          }),
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  const { raceId } = await res.json()
  // The race announcement can arrive before the HTTP response that names it.
  return new Promise((resolve) => {
    onUpdate = () => {
      const race = races.get(raceId)
      if (race && race.lanes.every((l) => finished.has(l.jobId))) resolve(race)
    }
    onUpdate()
  })
}

function report(rows) {
  // Every lane must match the first one tile by tile, whichever race it ran in.
  const reference = tileHashes.get(rows[0].jobId)
  const table = rows
    .map(({ label, jobId, progress: p }) => {
      const hashes = tileHashes.get(jobId)
      let diff = 0
      for (const [tile, hash] of reference) if (hashes.get(tile) !== hash) diff++
      const stats = Object.entries(p.stats)
      const pixels = stats.reduce((s, [, w]) => s + w.pixels, 0)
      // Wall time if every thread computed back to back with zero network or queueing.
      const laneThreads = stats.reduce((s, [id]) => s + (threads.get(id) ?? 1), 0)
      const computeMs = stats.reduce((s, [, w]) => s + w.computeNs / 1e6, 0) / laneThreads
      return { label, p, pixels, computeMs, diff }
    })
    .sort((a, b) => a.p.elapsedMs - b.p.elapsedMs)
    .map(({ label, p, pixels, computeMs, diff }, i, all) => ({
      rank: i + 1,
      lane: label,
      time: `${(p.elapsedMs / 1000).toFixed(2)} s`,
      'vs #1': i === 0 ? '' : `×${(p.elapsedMs / all[0].p.elapsedMs).toFixed(1)}`,
      'Mpx/s': (pixels / p.elapsedMs / 1000).toFixed(2),
      compute: `${Math.round((computeMs / p.elapsedMs) * 100)} %`,
      'first tile': `${p.firstTileMs.toFixed(0)} ms`,
      requeued: p.requeued,
      'tiles ≠': diff,
    }))
  console.table(table)
  ws.close()
  process.exit(table.some((r) => r['tiles ≠'] > 0) ? 1 : 0)
}

setTimeout(() => {
  console.error('timed out after 20 minutes')
  process.exit(2)
}, 1_200_000)
