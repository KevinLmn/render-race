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
    const started = process.hrtime.bigint()
    let pixels
    if (tile.kind === 'mandelbrot' && tile.params) pixels = renderMandelbrot(tile)
    else if (tile.kind === 'pathtrace' && tile.scene) pixels = renderPathTrace(tile.scene, tile)
    else {
      console.error(`unsupported tile kind ${tile.kind}`)
      continue
    }
    const computeNs = process.hrtime.bigint() - started

    // A network blip must not cost the tile: retry before giving up (the
    // coordinator would only hand it out again after its timeout).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${config.coordinator}/api/worker/result?job=${tile.jobId}&tile=${tile.tileId}`, {
          method: 'POST',
          headers: { 'X-Worker-Id': config.id, 'X-Compute-Ns': computeNs.toString() },
          body: pixels,
        })
        // 410: the job was replaced meanwhile, nothing to do.
        if (res.status !== 204 && res.status !== 410) console.error(`tile ${tile.tileId} rejected: ${res.status}`)
        break
      } catch (err) {
        console.error(`failed to send tile ${tile.tileId} (attempt ${attempt}): ${err.message}`)
        await new Promise((r) => setTimeout(r, 1000))
      }
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

// --- path tracer -----------------------------------------------------------------
// Port of workers/rust/src/pathtrace.rs, which is the reference: same operations
// in the same order, so the output is bit-identical. JS never fuses a*b+c.

// One RGBA8 pixel per pixel of the tile, row by row.
function renderPathTrace(scene, t) {
  const cam = scene.camera
  const out = new Uint8Array(t.w * t.h * 4)
  let k = 0
  for (let py = t.y; py < t.y + t.h; py++) {
    for (let px = t.x; px < t.x + t.w; px++) {
      const rng = newRng((Math.imul(py, t.width) + px) >>> 0, scene.seed)
      let sum = [0, 0, 0]
      for (let s = 0; s < scene.spp; s++) {
        const u = (px + rng.f64()) / t.width
        const v = (t.height - 1 - py + rng.f64()) / t.height
        const target = add(add(cam.lowerLeft, scale(cam.horizontal, u)), scale(cam.vertical, v))
        const dir = sub(target, cam.origin)
        sum = add(sum, rayColor(scene, cam.origin, dir, rng))
      }
      for (let c = 0; c < 3; c++) {
        let v = Math.sqrt(sum[c] / scene.spp) // gamma 2
        if (v > 0.999) v = 0.999
        out[k++] = Math.floor(256 * v)
      }
      out[k++] = 255
    }
  }
  return out
}

function rayColor(scene, origin, dir, rng) {
  let attenuation = [1, 1, 1]
  for (let depth = 0; depth < scene.maxDepth; depth++) {
    let closest = Infinity
    let hit = -1
    for (let k = 0; k < scene.spheres.length; k++) {
      const t = hitSphere(scene.spheres[k], origin, dir, 0.001, closest)
      if (t !== null) {
        closest = t
        hit = k
      }
    }
    if (hit < 0) {
      const ud = unit(dir)
      const t = 0.5 * (ud[1] + 1)
      return mul(attenuation, [1 - t + t * 0.5, 1 - t + t * 0.7, 1 - t + t * 1.0])
    }

    const s = scene.spheres[hit]
    const p = add(origin, scale(dir, closest))
    const outward = [(p[0] - s.c[0]) / s.r, (p[1] - s.c[1]) / s.r, (p[2] - s.c[2]) / s.r]
    const front = dot(dir, outward) < 0
    const normal = front ? outward : neg(outward)

    if (s.m === 0) {
      const r = unit(randomInUnitSphere(rng))
      dir = add(normal, r)
      attenuation = mul(attenuation, s.a)
    } else if (s.m === 1) {
      const reflected = reflect(unit(dir), normal)
      const r = randomInUnitSphere(rng)
      dir = add(reflected, scale(r, s.f))
      if (dot(dir, normal) <= 0) return [0, 0, 0]
      attenuation = mul(attenuation, s.a)
    } else {
      const ratio = front ? 1 / s.i : s.i
      const ud = unit(dir)
      const cos = min1(dot(neg(ud), normal))
      const sin = Math.sqrt(1 - cos * cos)
      // Short-circuit matters: the RNG is only drawn when refraction is possible.
      dir = ratio * sin > 1 || reflectance(cos, ratio) > rng.f64() ? reflect(ud, normal) : refract(ud, normal, ratio, cos)
    }
    origin = p
  }
  return [0, 0, 0]
}

function hitSphere(s, origin, dir, tMin, tMax) {
  const oc = sub(origin, s.c)
  const a = dot(dir, dir)
  const halfB = dot(oc, dir)
  const c = dot(oc, oc) - s.r * s.r
  const disc = halfB * halfB - a * c
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  let root = (-halfB - sq) / a
  if (root <= tMin || tMax <= root) {
    root = (-halfB + sq) / a
    if (root <= tMin || tMax <= root) return null
  }
  return root
}

function randomInUnitSphere(rng) {
  for (;;) {
    const x = 2 * rng.f64() - 1
    const y = 2 * rng.f64() - 1
    const z = 2 * rng.f64() - 1
    const p = [x, y, z]
    if (dot(p, p) < 1) return p
  }
}

function reflect(v, n) {
  return sub(v, scale(n, 2 * dot(v, n)))
}

function refract(uv, n, ratio, cos) {
  const perp = scale(add(uv, scale(n, cos)), ratio)
  const parallel = scale(n, -Math.sqrt(Math.abs(1 - dot(perp, perp))))
  return add(perp, parallel)
}

// Schlick's approximation, with x^5 as explicit multiplications (no pow).
function reflectance(cos, ior) {
  let r0 = (1 - ior) / (1 + ior)
  r0 = r0 * r0
  const x = 1 - cos
  return r0 + (1 - r0) * (x * x * x * x * x)
}

// Function declarations, not const arrows: the worker thread starts rendering
// from the top-level await above, before any const below would be initialized.
function min1(v) {
  return v < 1 ? v : 1
}
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function mul(a, b) {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}
function scale(a, t) {
  return [a[0] * t, a[1] * t, a[2] * t]
}
function neg(a) {
  return [-a[0], -a[1], -a[2]]
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function unit(a) {
  const len = Math.sqrt(dot(a, a))
  return [a[0] / len, a[1] / len, a[2] / len]
}

// PCG-style 32-bit hash generator, see the Rust worker. >>> 0 keeps values as u32.
function newRng(pixel, seed) {
  let state = (Math.imul(pixel, 0x9e3779b9) ^ seed) >>> 0
  const next = () => {
    state = (Math.imul(state, 747796405) + 2891336453) >>> 0
    const w = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0
    return ((w >>> 22) ^ w) >>> 0
  }
  next()
  // Uniform in [0, 1): 24 random bits, exact in every language's f64.
  return { f64: () => (next() >>> 8) * (1 / 16777216) }
}
