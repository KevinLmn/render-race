// Browser side: sends render jobs, draws tiles as they stream in, shows who computed what.

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
  job: null,
  view: { ...PRESETS[0] },
  image: null, // ImageData for the current job
  pixels: null, // Uint32Array view of image.data
  lut: null,
  tileOwner: null, // worker index per tile, -1 if not done
  flashes: [],
}

const imageCanvas = $('image')
const imageCtx = imageCanvas.getContext('2d')
const overlay = $('overlay')
const overlayCtx = overlay.getContext('2d')

// --- controls ------------------------------------------------------------------

for (const [i, p] of PRESETS.entries()) $('preset').add(new Option(p.name, i))
$('preset').addEventListener('change', () => {
  const p = PRESETS[Number($('preset').value)]
  state.view = { ...p }
  $('max-iter').value = p.iterExp
  updateIterLabel()
  render()
})
$('max-iter').addEventListener('input', updateIterLabel)
$('render').addEventListener('click', render)
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

imageCanvas.addEventListener('click', (e) => {
  const job = state.job
  if (!job) return
  const rect = imageCanvas.getBoundingClientRect()
  const px = ((e.clientX - rect.left) / rect.width) * job.spec.width
  const py = ((e.clientY - rect.top) / rect.height) * job.spec.height
  const { centerX, centerY, scale } = job.spec.params
  state.view.centerX = centerX + (px - job.spec.width / 2) * scale
  state.view.centerY = centerY + (py - job.spec.height / 2) * scale
  state.view.span = scale * job.spec.width * (e.shiftKey ? 4 : 0.25)
  render()
})

async function render() {
  const [width, height] = $('resolution').value.split('x').map(Number)
  const online = state.workers.filter((w) => w.online && state.selected.has(w.id))
  if (online.length === 0) {
    flashButton('Aucun worker sélectionné')
    return
  }
  const spec = {
    width,
    height,
    tileSize: Number($('tile-size').value),
    params: {
      centerX: state.view.centerX,
      centerY: state.view.centerY,
      scale: state.view.span / width,
      maxIter: maxIter(),
    },
    workers: online.map((w) => w.id),
  }
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  })
  if (!res.ok) flashButton(await res.text())
}

function flashButton(text) {
  const btn = $('render')
  const original = 'Lancer le rendu'
  btn.textContent = text
  btn.disabled = true
  setTimeout(() => {
    btn.textContent = original
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
    else if (msg.type === 'job') onJob(msg.job)
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
  const list = $('workers')
  list.replaceChildren(
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

function onJob(job) {
  state.job = job
  const { width, height, params } = job.spec
  for (const c of [imageCanvas, overlay]) {
    c.width = width
    c.height = height
  }
  state.image = imageCtx.createImageData(width, height)
  state.pixels = new Uint32Array(state.image.data.buffer)
  state.pixels.fill(0xff000000)
  imageCtx.putImageData(state.image, 0, 0)
  state.lut = buildLut(params.maxIter)
  state.tileOwner = new Int16Array(job.total).fill(-1)
  state.flashes = []
  state.view.centerX = params.centerX
  state.view.centerY = params.centerY
  state.view.span = params.scale * width
}

function onTile(buffer) {
  const job = state.job
  const head = new DataView(buffer, 0, 12)
  const jobId = head.getUint32(0, true)
  if (!job || jobId !== job.id) return
  const tileId = head.getUint32(4, true)
  const workerIndex = head.getUint16(8, true)
  const counts = new Uint32Array(buffer, 12)

  const ts = job.spec.tileSize
  const x = (tileId % job.cols) * ts
  const y = Math.floor(tileId / job.cols) * ts
  const w = Math.min(ts, job.spec.width - x)
  const h = Math.min(ts, job.spec.height - y)
  const { pixels, lut } = state
  const stride = job.spec.width
  for (let row = 0; row < h; row++) {
    const src = row * w
    const dst = (y + row) * stride + x
    for (let col = 0; col < w; col++) pixels[dst + col] = lut[counts[src + col]]
  }
  imageCtx.putImageData(state.image, 0, 0, x, y, w, h)
  state.tileOwner[tileId] = workerIndex
  state.flashes.push({ x, y, w, h, workerIndex, at: performance.now() })
}

function onProgress(p) {
  if (!state.job || p.jobId !== state.job.id) return
  const pct = p.total ? (p.done / p.total) * 100 : 0
  $('bar').style.width = `${pct}%`
  $('s-tiles').textContent = `${p.done} / ${p.total}`
  $('s-elapsed').textContent = formatMs(p.elapsedMs)
  $('s-first').textContent = p.firstTileMs ? formatMs(p.firstTileMs) : '–'
  const pixelsDone = Object.values(p.stats).reduce((sum, s) => sum + s.pixels, 0)
  $('s-rate').textContent = p.elapsedMs ? `${(pixelsDone / p.elapsedMs / 1000).toFixed(1)} Mpx/s` : '–'
  $('s-inflight').textContent = p.inflight
  $('s-requeued').textContent = p.requeued

  const rows = Object.entries(p.stats)
    .map(([id, s]) => ({ id, ...s, worker: state.workers.find((w) => w?.id === id) }))
    .sort((a, b) => b.tiles - a.tiles)
  $('per-worker').replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement('tr')
      const label = r.worker ? `${r.worker.machine} · ${r.worker.lang}` : r.id
      tr.innerHTML = `<td><span class="swatch" style="background:${colorOf(r.worker?.index ?? 0)}"></span><span></span></td>
        <td>${r.tiles}</td>
        <td>${((r.tiles / Math.max(1, p.done)) * 100).toFixed(0)}%</td>
        <td>${(r.computeNs / r.tiles / 1e6).toFixed(1)}</td>`
      tr.querySelector('td span:last-child').textContent = label
      return tr
    }),
  )
}

// --- drawing ---------------------------------------------------------------------

function colorOf(index) {
  return WORKER_COLORS[index % WORKER_COLORS.length]
}

// Iteration count -> packed ABGR pixel. Points that never escape are black.
function buildLut(max) {
  const lut = new Uint32Array(max + 1)
  for (let i = 0; i < max; i++) {
    const t = Math.sqrt(i) * 0.18
    const r = 0.5 + 0.5 * Math.cos(6.2832 * (t + 0.0))
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

function drawOverlay(now) {
  requestAnimationFrame(drawOverlay)
  const job = state.job
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  if (!job) return
  const ts = job.spec.tileSize
  const lineWidth = Math.max(1, job.spec.width / 640)

  if ($('mosaic').checked) {
    overlayCtx.globalAlpha = 0.35
    for (let id = 0; id < state.tileOwner.length; id++) {
      const owner = state.tileOwner[id]
      if (owner < 0) continue
      overlayCtx.fillStyle = colorOf(owner)
      overlayCtx.fillRect((id % job.cols) * ts, Math.floor(id / job.cols) * ts, ts, ts)
    }
    overlayCtx.globalAlpha = 1
    return
  }

  state.flashes = state.flashes.filter((f) => now - f.at < FLASH_MS)
  overlayCtx.lineWidth = lineWidth
  for (const f of state.flashes) {
    const life = 1 - (now - f.at) / FLASH_MS
    overlayCtx.globalAlpha = life * 0.9
    overlayCtx.strokeStyle = colorOf(f.workerIndex)
    overlayCtx.strokeRect(f.x + lineWidth / 2, f.y + lineWidth / 2, f.w - lineWidth, f.h - lineWidth)
    overlayCtx.globalAlpha = life * 0.22
    overlayCtx.fillStyle = colorOf(f.workerIndex)
    overlayCtx.fillRect(f.x, f.y, f.w, f.h)
  }
  overlayCtx.globalAlpha = 1
}
requestAnimationFrame(drawOverlay)

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}
