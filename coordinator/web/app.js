// Browser side: starts races, draws every lane as tiles stream in, ranks the lanes.

const $ = (id) => document.getElementById(id)

const WORKER_COLORS = ['#ff8a3d', '#3dd6ff', '#a78bfa', '#2fbf71', '#ff4d6d', '#ffd23d', '#4d7cff', '#f472b6']
const FLASH_MS = 900

// span = width of the view in the complex plane, so framing survives resolution changes.
const PRESETS = [
  { name: "Vue d'ensemble", centerX: -0.5, centerY: 0, span: 3.2, iterExp: 9 },
  { name: 'Vallée des hippocampes', centerX: -0.743643887037151, centerY: 0.13182590420533, span: 0.0006, iterExp: 11 },
  { name: 'Vallée des éléphants', centerX: 0.2925, centerY: 0.0149, span: 0.012, iterExp: 10.5 },
  { name: 'Triple spirale', centerX: -0.0881, centerY: 0.6545, span: 0.006, iterExp: 11 },
  { name: 'Mini-Mandelbrot', centerX: -1.768778833, centerY: -0.001738996, span: 0.00000008, iterExp: 13 },
]

const state = {
  workers: [], // indexed by worker.index
  selected: new Set(),
  knownWorkers: new Set(),
  race: null,
  lanes: new Map(), // jobId -> lane
  view: { ...PRESETS[0] },
  lut: null,
}

// --- controls ------------------------------------------------------------------

for (const [i, p] of PRESETS.entries()) $('preset').add(new Option(p.name, i))
$('preset').addEventListener('change', () => {
  const p = PRESETS[Number($('preset').value)]
  state.view = { ...p }
  $('max-iter').value = p.iterExp
  updateIterLabel()
  start()
})
$('max-iter').addEventListener('input', updateIterLabel)
$('spp').addEventListener('input', updateSppLabel)
$('kind').addEventListener('change', () => {
  const path = $('kind').value === 'pathtrace'
  $('mandel-controls').hidden = path
  $('iter-field').hidden = path
  $('path-controls').hidden = !path
  $('stage-hint').hidden = path
})
$('render').addEventListener('click', start)
$('reset').addEventListener('click', () => {
  $('preset').value = 0
  $('preset').dispatchEvent(new Event('change'))
})

function maxIter() {
  return Math.round(2 ** Number($('max-iter').value))
}
function updateIterLabel() {
  $('iter-out').value = maxIter().toLocaleString('fr-FR')
}
updateIterLabel()

function spp() {
  return 2 ** Number($('spp').value)
}
function updateSppLabel() {
  $('spp-out').value = spp()
}
updateSppLabel()

function zoomAt(e, canvas) {
  const race = state.race
  if (!race || race.spec.kind !== 'mandelbrot') return
  const rect = canvas.getBoundingClientRect()
  const px = ((e.clientX - rect.left) / rect.width) * race.spec.width
  const py = ((e.clientY - rect.top) / rect.height) * race.spec.height
  const { centerX, centerY, scale } = race.spec.params
  state.view.centerX = centerX + (px - race.spec.width / 2) * scale
  state.view.centerY = centerY + (py - race.spec.height / 2) * scale
  state.view.span = scale * race.spec.width * (e.shiftKey ? 4 : 0.25)
  start()
}

function buildLanes() {
  const workers = state.workers.filter((w) => w?.online && state.selected.has(w.id))
  const key = {
    all: () => 'Toutes les machines',
    machine: (w) => w.machine,
    lang: (w) => w.lang,
    worker: (w) => `${w.machine} · ${w.lang}`,
  }[$('mode').value]
  return [...Map.groupBy(workers, key)].map(([label, ws]) => ({ label, workers: ws.map((w) => w.id) }))
}

async function start() {
  const [width, height] = $('resolution').value.split('x').map(Number)
  const lanes = buildLanes()
  if (lanes.length === 0) return flashButton('Aucun worker sélectionné')
  if (lanes.length > 8) return flashButton('8 couloirs maximum')
  const res = await fetch('/api/races', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      width,
      height,
      tileSize: Number($('tile-size').value),
      lanes,
      ...($('kind').value === 'pathtrace'
        ? { kind: 'pathtrace', pathTrace: { preset: $('scene').value, spp: spp(), maxDepth: 10 } }
        : {
            kind: 'mandelbrot',
            params: {
              centerX: state.view.centerX,
              centerY: state.view.centerY,
              scale: state.view.span / width,
              maxIter: maxIter(),
            },
          }),
    }),
  })
  if (!res.ok) flashButton(await res.text())
}

function flashButton(text) {
  const btn = $('render')
  btn.textContent = text
  btn.disabled = true
  setTimeout(() => {
    btn.textContent = 'Lancer'
    btn.disabled = false
  }, 1600)
}

// --- coordinator connection ------------------------------------------------------

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => $('conn').classList.add('on')
  ws.onclose = () => {
    $('conn').classList.remove('on')
    setTimeout(connect, 1000)
  }
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return onTile(e.data)
    const msg = JSON.parse(e.data)
    if (msg.type === 'workers') onWorkers(msg.workers)
    else if (msg.type === 'race') onRace(msg.race)
    else if (msg.type === 'progress') onProgress(msg)
  }
}
connect()

function onWorkers(workers) {
  state.workers = []
  for (const w of workers) {
    state.workers[w.index] = w
    if (!state.knownWorkers.has(w.id)) {
      state.knownWorkers.add(w.id) // new workers are selected by default
      state.selected.add(w.id)
    }
  }
  $('workers').replaceChildren(
    ...workers.map((w) => {
      const li = document.createElement('li')
      li.className = w.online ? '' : 'offline'
      li.innerHTML = `<label>
        <input type="checkbox" ${state.selected.has(w.id) ? 'checked' : ''}>
        <span class="swatch" style="background:${colorOf(w.index)}"></span>
        <span class="worker-name"></span>
        <span class="worker-meta">${w.threads} thr</span>
      </label>`
      li.querySelector('.worker-name').textContent = `${w.machine} · ${w.lang}`
      li.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.selected.add(w.id)
        else state.selected.delete(w.id)
      })
      return li
    }),
  )
  $('no-workers').hidden = workers.some((w) => w.online)
}

function onRace(race) {
  state.race = race
  const { width, height, params } = race.spec
  if (params) {
    state.lut = buildLut(params.maxIter)
    state.view.centerX = params.centerX
    state.view.centerY = params.centerY
    state.view.span = params.scale * width
  }

  const container = $('lanes')
  const cols = race.lanes.length === 1 ? 1 : race.lanes.length <= 4 ? 2 : race.lanes.length <= 6 ? 3 : 4
  container.style.setProperty('--cols', cols)
  container.style.setProperty('--rows', Math.ceil(race.lanes.length / cols))
  state.lanes.clear()
  container.replaceChildren(
    ...race.lanes.map((job) => {
      const el = document.createElement('article')
      el.className = 'lane'
      el.innerHTML = `<header><span class="rank"></span><span class="lane-label"></span><span class="lane-time">–</span></header>
        <div class="lane-canvas"><canvas class="image"></canvas><canvas class="overlay"></canvas></div>
        <footer><div class="lane-bar"><span></span></div><span class="lane-stats">0 / ${race.total}</span></footer>`
      el.querySelector('.lane-label').textContent = job.label
      const image = el.querySelector('.image')
      const overlay = el.querySelector('.overlay')
      for (const c of [image, overlay]) {
        c.width = width
        c.height = height
      }
      image.addEventListener('click', (e) => zoomAt(e, image))
      image.style.cursor = race.spec.kind === 'mandelbrot' ? 'zoom-in' : 'default'
      const ctx = image.getContext('2d')
      const imageData = ctx.createImageData(width, height)
      const pixels = new Uint32Array(imageData.data.buffer)
      pixels.fill(0xff000000)
      ctx.putImageData(imageData, 0, 0)
      const lane = {
        job,
        el,
        ctx,
        imageData,
        pixels,
        octx: overlay.getContext('2d'),
        overlay,
        tileOwner: new Int16Array(race.total).fill(-1),
        flashes: [],
        progress: null,
      }
      state.lanes.set(job.jobId, lane)
      return el
    }),
  )
  renderRanking()
}

function onTile(buffer) {
  const race = state.race
  const head = new DataView(buffer, 0, 12)
  const lane = state.lanes.get(head.getUint32(0, true))
  if (!race || !lane) return
  const tileId = head.getUint32(4, true)
  const workerIndex = head.getUint16(8, true)

  const ts = race.spec.tileSize
  const x = (tileId % race.cols) * ts
  const y = Math.floor(tileId / race.cols) * ts
  const w = Math.min(ts, race.spec.width - x)
  const h = Math.min(ts, race.spec.height - y)
  const stride = race.spec.width
  if (race.spec.kind === 'pathtrace') {
    // Already RGBA8: copy row by row.
    const rgba = new Uint8Array(buffer, 12)
    const data = lane.imageData.data
    for (let row = 0; row < h; row++) data.set(rgba.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * stride + x) * 4)
  } else {
    // Iteration counts: color them through the palette.
    const counts = new Uint32Array(buffer, 12)
    const { pixels } = lane
    const lut = state.lut
    for (let row = 0; row < h; row++) {
      const src = row * w
      const dst = (y + row) * stride + x
      for (let col = 0; col < w; col++) pixels[dst + col] = lut[counts[src + col]]
    }
  }
  lane.ctx.putImageData(lane.imageData, 0, 0, x, y, w, h)
  lane.tileOwner[tileId] = workerIndex
  lane.flashes.push({ x, y, w, h, workerIndex, at: performance.now() })
}

function onProgress(p) {
  const lane = state.lanes.get(p.jobId)
  if (!lane) return
  lane.progress = p
  lane.el.querySelector('.lane-bar span').style.width = `${(p.done / p.total) * 100}%`
  lane.el.querySelector('.lane-time').textContent = formatMs(p.elapsedMs)
  const parts = [`${p.done} / ${p.total}`, `${mpxPerSec(p)} Mpx/s`]
  if (p.requeued) parts.push(`${p.requeued} redistribuées`)
  if (p.mismatches) parts.push(`⚠ ${p.mismatches} tuiles différentes`)
  lane.el.querySelector('.lane-stats').textContent = parts.join(' · ')
  lane.el.classList.toggle('finished', p.finished)
  lane.el.classList.toggle('mismatch', p.mismatches > 0)
  renderRanking()
  renderPerWorker()
}

// Finished lanes by time, then running lanes by progress.
function renderRanking() {
  const lanes = [...state.lanes.values()]
  const ranked = lanes.sort((a, b) => {
    const pa = a.progress
    const pb = b.progress
    if (pa?.finished && pb?.finished) return pa.elapsedMs - pb.elapsedMs
    if (pa?.finished !== pb?.finished) return pa?.finished ? -1 : 1
    return (pb?.done ?? 0) - (pa?.done ?? 0)
  })
  const winner = ranked[0]?.progress?.elapsedMs
  $('ranking').replaceChildren(
    ...ranked.map((lane, i) => {
      const p = lane.progress
      const li = document.createElement('li')
      li.className = p?.finished ? 'finished' : ''
      const gap = p?.finished && i > 0 ? ` <small>×${(p.elapsedMs / winner).toFixed(2)}</small>` : ''
      const time = p?.finished ? formatMs(p.elapsedMs) : `${Math.round(((p?.done ?? 0) / (p?.total || 1)) * 100)} %`
      li.innerHTML = `<span class="pos">${i + 1}</span><span class="name"></span><span class="time">${time}${gap}</span>`
      li.querySelector('.name').textContent = lane.job.label
      if (p?.mismatches) li.querySelector('.name').textContent += ' ⚠'
      lane.el.querySelector('.rank').textContent = p?.finished ? `#${i + 1}` : ''
      return li
    }),
  )
  $('ranking-hint').hidden = ranked.length > 0
}

// Compute-only throughput per worker, aggregated over every lane of the race.
function renderPerWorker() {
  const totals = new Map()
  for (const lane of state.lanes.values()) {
    for (const [id, s] of Object.entries(lane.progress?.stats ?? {})) {
      const t = totals.get(id) ?? { tiles: 0, pixels: 0, computeNs: 0 }
      t.tiles += s.tiles
      t.pixels += s.pixels
      t.computeNs += s.computeNs
      totals.set(id, t)
    }
  }
  const rows = [...totals].sort((a, b) => b[1].pixels / b[1].computeNs - a[1].pixels / a[1].computeNs)
  $('per-worker').replaceChildren(
    ...rows.map(([id, t]) => {
      const worker = state.workers.find((w) => w?.id === id)
      const tr = document.createElement('tr')
      tr.innerHTML = `<td><span class="swatch" style="background:${colorOf(worker?.index ?? 0)}"></span><span></span></td>
        <td>${t.tiles}</td>
        <td>${(t.computeNs / t.tiles / 1e6).toFixed(1)}</td>
        <td>${((t.pixels / t.computeNs) * 1e3).toFixed(2)}</td>`
      tr.querySelector('td span:last-child').textContent = worker ? `${worker.machine} · ${worker.lang}` : id
      return tr
    }),
  )
}

// --- drawing ---------------------------------------------------------------------

function colorOf(index) {
  return WORKER_COLORS[index % WORKER_COLORS.length]
}

function mpxPerSec(p) {
  const pixels = Object.values(p.stats).reduce((sum, s) => sum + s.pixels, 0)
  return p.elapsedMs ? (pixels / p.elapsedMs / 1000).toFixed(1) : '0'
}

// Iteration count -> packed ABGR pixel. Points that never escape are black.
function buildLut(max) {
  const lut = new Uint32Array(max + 1)
  for (let i = 0; i < max; i++) {
    const t = Math.sqrt(i) * 0.18
    const r = 0.5 + 0.5 * Math.cos(6.2832 * t)
    const g = 0.5 + 0.5 * Math.cos(6.2832 * (t + 0.15))
    const b = 0.5 + 0.5 * Math.cos(6.2832 * (t + 0.3))
    // Fade in from black near the outside so the background stays calm.
    const fade = Math.min(1, i / 24)
    lut[i] =
      (255 << 24) |
      (Math.round(b * 255 * fade) << 16) |
      (Math.round(g * 255 * fade) << 8) |
      Math.round(r * 255 * fade)
  }
  lut[max] = 0xff000000
  return lut
}

function drawOverlays(now) {
  requestAnimationFrame(drawOverlays)
  const race = state.race
  if (!race) return
  const ts = race.spec.tileSize
  const lineWidth = Math.max(1, race.spec.width / 640)
  const mosaic = $('mosaic').checked

  for (const lane of state.lanes.values()) {
    const { octx, overlay } = lane
    lane.flashes = lane.flashes.filter((f) => now - f.at < FLASH_MS)
    // Nothing to animate: leave the overlay as it is.
    if (!mosaic && lane.flashes.length === 0 && !lane.dirtyOverlay) continue
    octx.clearRect(0, 0, overlay.width, overlay.height)
    lane.dirtyOverlay = lane.flashes.length > 0

    if (mosaic) {
      octx.globalAlpha = 0.35
      for (let id = 0; id < lane.tileOwner.length; id++) {
        const owner = lane.tileOwner[id]
        if (owner < 0) continue
        octx.fillStyle = colorOf(owner)
        octx.fillRect((id % race.cols) * ts, Math.floor(id / race.cols) * ts, ts, ts)
      }
      octx.globalAlpha = 1
      lane.dirtyOverlay = true
      continue
    }

    octx.lineWidth = lineWidth
    for (const f of lane.flashes) {
      const life = 1 - (now - f.at) / FLASH_MS
      octx.globalAlpha = life * 0.9
      octx.strokeStyle = colorOf(f.workerIndex)
      octx.strokeRect(f.x + lineWidth / 2, f.y + lineWidth / 2, f.w - lineWidth, f.h - lineWidth)
      octx.globalAlpha = life * 0.22
      octx.fillStyle = colorOf(f.workerIndex)
      octx.fillRect(f.x, f.y, f.w, f.h)
    }
    octx.globalAlpha = 1
  }
}
requestAnimationFrame(drawOverlays)

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}
