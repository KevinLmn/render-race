// JS worker: the main thread spawns one worker_thread per core, each one pulls
// a tile from the coordinator, renders it and posts the result back.
// No dependencies: Node >= 22 (global fetch, util.parseArgs).

import { availableParallelism, hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { Worker, isMainThread, workerData } from 'node:worker_threads'

if (isMainThread) {
  const { values } = parseArgs({
    options: {
      coordinator: { type: 'string', default: 'http://localhost:8080' },
      machine: { type: 'string', default: hostname().split('.')[0].toLowerCase() },
      threads: { type: 'string', default: String(availableParallelism()) },
    },
  })
  const config = {
    coordinator: values.coordinator.replace(/\/+$/, ''),
    machine: values.machine,
    threads: Number(values.threads),
    id: `${values.machine}-js`,
  }
  console.log(`worker ${config.id} -> ${config.coordinator} with ${config.threads} threads`)
  for (let i = 0; i < config.threads; i++) {
    new Worker(new URL(import.meta.url), { workerData: config }).on('error', (err) => {
      console.error('thread crashed:', err)
      process.exit(1)
    })
  }
} else {
  await workLoop(workerData)
}

async function workLoop(config) {
  const headers = {
    'X-Worker-Id': config.id,
    'X-Worker-Machine': config.machine,
    'X-Worker-Lang': 'js',
    'X-Worker-Threads': String(config.threads),
  }
  for (;;) {
    let tile
    try {
      const res = await fetch(`${config.coordinator}/api/worker/next`, {
        headers,
        // Longer than the coordinator's long-poll so an idle poll isn't an error.
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 204) continue // poll timed out with no work
      if (!res.ok) throw new Error(`unexpected status ${res.status}`)
      tile = await res.json()
    } catch (err) {
      console.error(`coordinator unreachable: ${err.message}`)
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    if (tile.kind !== 'mandelbrot') {
      console.error(`unsupported tile kind ${tile.kind}`)
      continue
    }

    const started = process.hrtime.bigint()
    const pixels = renderMandelbrot(tile)
    const computeNs = process.hrtime.bigint() - started

    try {
      const res = await fetch(`${config.coordinator}/api/worker/result?job=${tile.jobId}&tile=${tile.tileId}`, {
        method: 'POST',
        headers: { 'X-Worker-Id': config.id, 'X-Compute-Ns': computeNs.toString() },
        body: pixels,
      })
      // 410: the job was replaced meanwhile, nothing to do.
      if (res.status !== 204 && res.status !== 410) console.error(`tile ${tile.tileId} rejected: ${res.status}`)
    } catch (err) {
      console.error(`failed to send tile ${tile.tileId}: ${err.message}`)
    }
  }
}

// One little-endian u32 escape iteration count per pixel, row by row.
// Uint32Array is little-endian on every platform we run on (x86_64, arm64).
function renderMandelbrot(t) {
  const { centerX, centerY, scale, maxIter } = t.params
  const halfW = t.width / 2
  const halfH = t.height / 2
  const out = new Uint32Array(t.w * t.h)
  let k = 0
  for (let py = t.y; py < t.y + t.h; py++) {
    const cy = centerY + (py + 0.5 - halfH) * scale
    for (let px = t.x; px < t.x + t.w; px++) {
      const cx = centerX + (px + 0.5 - halfW) * scale
      out[k++] = escapeTime(cx, cy, maxIter)
    }
  }
  return new Uint8Array(out.buffer)
}

function escapeTime(cx, cy, maxIter) {
  let x = 0
  let y = 0
  let i = 0
  for (; i < maxIter; i++) {
    const x2 = x * x
    const y2 = y * y
    if (x2 + y2 > 4) break
    y = 2 * x * y + cy
    x = x2 - y2 + cx
  }
  return i
}
