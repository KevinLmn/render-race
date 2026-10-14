"""GPU worker: renders tiles with CUDA kernels, one GPU thread per pixel.

The kernels are ports of the Rust worker (workers/rust/src) and must stay
bit-identical with it: double precision, the same operation order, and
--fmad=false so nvcc does not fuse a*b+c into FMA instructions (it does by default).

Several puller threads each fetch a tile, launch the kernel on their own CUDA
stream and post the result, so HTTP round trips overlap with GPU work.

    python worker.py --coordinator http://mini:8787 --machine pc --threads 32
"""

import argparse
import http.client
import json
import socket
import threading
import time
from urllib.parse import urlsplit

import cupy as cp
import numpy as np

KERNELS = r"""
extern "C" {

// ---- Mandelbrot: one u32 escape iteration count per pixel ----

__global__ void mandelbrot(unsigned int* out, int x0, int y0, int w, int h, int width, int height,
                           double centerX, double centerY, double scale, unsigned int maxIter) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= w * h) return;
    int px = x0 + i % w, py = y0 + i / w;
    double halfW = width / 2.0, halfH = height / 2.0;
    double cy = centerY + ((double)py + 0.5 - halfH) * scale;
    double cx = centerX + ((double)px + 0.5 - halfW) * scale;
    double x = 0.0, y = 0.0;
    unsigned int n = 0;
    while (n < maxIter) {
        double x2 = x * x, y2 = y * y;
        if (x2 + y2 > 4.0) break;
        y = 2.0 * x * y + cy;
        x = x2 - y2 + cx;
        n++;
    }
    out[i] = n;
}

// ---- Path tracer: one RGBA8 pixel per pixel ----

struct V { double x, y, z; };
__device__ V mk(double x, double y, double z) { V v; v.x = x; v.y = y; v.z = z; return v; }
__device__ V add(V a, V b) { return mk(a.x + b.x, a.y + b.y, a.z + b.z); }
__device__ V sub(V a, V b) { return mk(a.x - b.x, a.y - b.y, a.z - b.z); }
__device__ V mul(V a, V b) { return mk(a.x * b.x, a.y * b.y, a.z * b.z); }
__device__ V scale(V a, double t) { return mk(a.x * t, a.y * t, a.z * t); }
__device__ V neg(V a) { return mk(-a.x, -a.y, -a.z); }
__device__ double dot(V a, V b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
__device__ V unit(V a) { double l = sqrt(dot(a, a)); return mk(a.x / l, a.y / l, a.z / l); }
__device__ double min1(double v) { return v < 1.0 ? v : 1.0; }

__device__ unsigned int rng_next(unsigned int* s) {
    *s = *s * 747796405u + 2891336453u;
    unsigned int st = *s;
    unsigned int w = ((st >> ((st >> 28) + 4u)) ^ st) * 277803737u;
    return (w >> 22) ^ w;
}
__device__ double rng_f64(unsigned int* s) { return (double)(rng_next(s) >> 8) * (1.0 / 16777216.0); }

// Sphere layout, 10 doubles: cx cy cz r material ax ay az fuzz ior
#define SPHERE 10

__device__ bool hit_sphere(const double* s, V o, V d, double tMin, double tMax, double* out) {
    V oc = sub(o, mk(s[0], s[1], s[2]));
    double a = dot(d, d);
    double halfB = dot(oc, d);
    double c = dot(oc, oc) - s[3] * s[3];
    double disc = halfB * halfB - a * c;
    if (disc < 0.0) return false;
    double sq = sqrt(disc);
    double root = (-halfB - sq) / a;
    if (root <= tMin || tMax <= root) {
        root = (-halfB + sq) / a;
        if (root <= tMin || tMax <= root) return false;
    }
    *out = root;
    return true;
}

__device__ V random_in_unit_sphere(unsigned int* rng) {
    for (;;) {
        double x = 2.0 * rng_f64(rng) - 1.0;
        double y = 2.0 * rng_f64(rng) - 1.0;
        double z = 2.0 * rng_f64(rng) - 1.0;
        V p = mk(x, y, z);
        if (dot(p, p) < 1.0) return p;
    }
}

__device__ V reflect(V v, V n) { return sub(v, scale(n, 2.0 * dot(v, n))); }

__device__ V refract(V uv, V n, double ratio, double cos) {
    V perp = scale(add(uv, scale(n, cos)), ratio);
    V parallel = scale(n, -sqrt(fabs(1.0 - dot(perp, perp))));
    return add(perp, parallel);
}

__device__ double reflectance(double cos, double ior) {
    double r0 = (1.0 - ior) / (1.0 + ior);
    r0 = r0 * r0;
    double x = 1.0 - cos;
    return r0 + (1.0 - r0) * (x * x * x * x * x);
}

__device__ V ray_color(const double* spheres, int count, unsigned int maxDepth, V origin, V dir, unsigned int* rng) {
    V attenuation = mk(1.0, 1.0, 1.0);
    for (unsigned int depth = 0; depth < maxDepth; depth++) {
        double closest = __longlong_as_double(0x7ff0000000000000LL);  // +inf
        int hit = -1;
        for (int k = 0; k < count; k++) {
            double t;
            if (hit_sphere(spheres + k * SPHERE, origin, dir, 0.001, closest, &t)) {
                closest = t;
                hit = k;
            }
        }
        if (hit < 0) {
            V ud = unit(dir);
            double t = 0.5 * (ud.y + 1.0);
            return mul(attenuation, mk((1.0 - t) + t * 0.5, (1.0 - t) + t * 0.7, (1.0 - t) + t * 1.0));
        }
        const double* s = spheres + hit * SPHERE;
        V p = add(origin, scale(dir, closest));
        V outward = mk((p.x - s[0]) / s[3], (p.y - s[1]) / s[3], (p.z - s[2]) / s[3]);
        bool front = dot(dir, outward) < 0.0;
        V normal = front ? outward : neg(outward);
        int material = (int)s[4];
        if (material == 0) {
            V r = unit(random_in_unit_sphere(rng));
            dir = add(normal, r);
            attenuation = mul(attenuation, mk(s[5], s[6], s[7]));
        } else if (material == 1) {
            V reflected = reflect(unit(dir), normal);
            V r = random_in_unit_sphere(rng);
            dir = add(reflected, scale(r, s[8]));
            if (dot(dir, normal) <= 0.0) return mk(0.0, 0.0, 0.0);
            attenuation = mul(attenuation, mk(s[5], s[6], s[7]));
        } else {
            double ratio = front ? 1.0 / s[9] : s[9];
            V ud = unit(dir);
            double cos = min1(dot(neg(ud), normal));
            double sin = sqrt(1.0 - cos * cos);
            // Short-circuit matters: the RNG is only drawn when refraction is possible.
            if (ratio * sin > 1.0 || reflectance(cos, ratio) > rng_f64(rng)) dir = reflect(ud, normal);
            else dir = refract(ud, normal, ratio, cos);
        }
        origin = p;
    }
    return mk(0.0, 0.0, 0.0);
}

// camera, 12 doubles: origin lowerLeft horizontal vertical
__global__ void pathtrace(unsigned char* out, int x0, int y0, int w, int h, int width, int height,
                          const double* cam, const double* spheres, int count,
                          unsigned int seed, unsigned int spp, unsigned int maxDepth) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= w * h) return;
    unsigned int px = x0 + i % w, py = y0 + i / w;
    V origin = mk(cam[0], cam[1], cam[2]);
    V lowerLeft = mk(cam[3], cam[4], cam[5]);
    V horizontal = mk(cam[6], cam[7], cam[8]);
    V vertical = mk(cam[9], cam[10], cam[11]);

    unsigned int rng = (py * (unsigned int)width + px) * 0x9E3779B9u ^ seed;
    rng_next(&rng);
    V sum = mk(0.0, 0.0, 0.0);
    for (unsigned int k = 0; k < spp; k++) {
        double u = ((double)px + rng_f64(&rng)) / (double)width;
        double v = ((double)(height - 1 - py) + rng_f64(&rng)) / (double)height;
        V target = add(add(lowerLeft, scale(horizontal, u)), scale(vertical, v));
        V dir = sub(target, origin);
        sum = add(sum, ray_color(spheres, count, maxDepth, origin, dir, &rng));
    }
    double c[3] = {sum.x, sum.y, sum.z};
    for (int k = 0; k < 3; k++) {
        double g = sqrt(c[k] / (double)spp);  // gamma 2
        if (g > 0.999) g = 0.999;
        out[i * 4 + k] = (unsigned char)(256.0 * g);
    }
    out[i * 4 + 3] = 255;
}

}
"""

BLOCK = 256


class Gpu:
    """Compiled kernels plus a one-entry cache of the current scene on the device."""

    def __init__(self):
        module = cp.RawModule(code=KERNELS, options=("--fmad=false", "--std=c++14"))
        self.mandelbrot = module.get_function("mandelbrot")
        self.pathtrace = module.get_function("pathtrace")
        self.lock = threading.Lock()
        self.scene_job = None
        self.scene_arrays = None

    def scene(self, job_id, scene):
        with self.lock:
            if self.scene_job != job_id:
                cam = scene["camera"]
                camera = np.array(cam["origin"] + cam["lowerLeft"] + cam["horizontal"] + cam["vertical"], dtype=np.float64)
                spheres = np.array(
                    [[*s["c"], s["r"], s["m"], *s["a"], s["f"], s["i"]] for s in scene["spheres"]], dtype=np.float64
                )
                self.scene_arrays = (cp.asarray(camera), cp.asarray(spheres.ravel()), len(scene["spheres"]))
                self.scene_job = job_id
            return self.scene_arrays

    def render(self, tile, stream):
        n = tile["w"] * tile["h"]
        grid = ((n + BLOCK - 1) // BLOCK,)
        geometry = (np.int32(tile["x"]), np.int32(tile["y"]), np.int32(tile["w"]), np.int32(tile["h"]),
                    np.int32(tile["width"]), np.int32(tile["height"]))
        with stream:
            if tile["kind"] == "mandelbrot":
                p = tile["params"]
                out = cp.empty(n, dtype=cp.uint32)
                self.mandelbrot(grid, (BLOCK,), (out, *geometry, np.float64(p["centerX"]), np.float64(p["centerY"]),
                                                np.float64(p["scale"]), np.uint32(p["maxIter"])))
            else:
                s = tile["scene"]
                camera, spheres, count = self.scene(tile["jobId"], s)
                out = cp.empty(n * 4, dtype=cp.uint8)
                self.pathtrace(grid, (BLOCK,), (out, *geometry, camera, spheres, np.int32(count),
                                               np.uint32(s["seed"]), np.uint32(s["spp"]), np.uint32(s["maxDepth"])))
            host = out.get(stream=stream)
            stream.synchronize()
        return host.tobytes()  # little-endian u32 or RGBA8, same as the CPU workers


def send_result(conn, url, cfg, tile, pixels, compute_ns):
    """A network blip must not cost the tile: retry before giving up (the
    coordinator would only hand it out again after its timeout)."""
    path = f"/api/worker/result?job={tile['jobId']}&tile={tile['tileId']}"
    headers = {"X-Worker-Id": cfg.id, "X-Compute-Ns": str(compute_ns)}
    for attempt in range(1, 4):
        try:
            conn.request("POST", path, body=pixels, headers=headers)
            res = conn.getresponse()
            res.read()
            if res.status not in (204, 410):  # 410: the job was replaced meanwhile
                print(f"tile {tile['tileId']} rejected: {res.status}", flush=True)
            return conn
        except (OSError, http.client.HTTPException) as err:
            print(f"failed to send tile {tile['tileId']} (attempt {attempt}): {err}", flush=True)
            conn.close()
            conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=30)
            time.sleep(1)
    return conn


def work_loop(gpu, cfg):
    url = urlsplit(cfg.coordinator)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=30)
    stream = cp.cuda.Stream(non_blocking=True)
    headers = {
        "X-Worker-Id": cfg.id,
        "X-Worker-Machine": cfg.machine,
        "X-Worker-Lang": "cuda",
        "X-Worker-Threads": str(cfg.threads),
    }
    while True:
        try:
            conn.request("GET", "/api/worker/next", headers=headers)
            res = conn.getresponse()
            body = res.read()
            if res.status == 204:
                continue  # poll timed out with no work
            if res.status != 200:
                raise RuntimeError(f"unexpected status {res.status}")
            tile = json.loads(body)
            if tile["kind"] not in ("mandelbrot", "pathtrace"):
                print(f"unsupported tile kind {tile['kind']}", flush=True)
                continue

            started = time.perf_counter_ns()
            pixels = gpu.render(tile, stream)
            compute_ns = time.perf_counter_ns() - started

            conn = send_result(conn, url, cfg, tile, pixels, compute_ns)
        except (OSError, http.client.HTTPException, RuntimeError) as err:
            print(f"coordinator unreachable: {err}", flush=True)
            conn.close()
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--coordinator", default="http://localhost:8080")
    parser.add_argument("--machine", default=socket.gethostname().split(".")[0].lower())
    parser.add_argument("--threads", type=int, default=16, help="concurrent tiles in flight")
    cfg = parser.parse_args()
    cfg.coordinator = cfg.coordinator.rstrip("/")
    cfg.id = f"{cfg.machine}-cuda"

    gpu = Gpu()
    name = cp.cuda.runtime.getDeviceProperties(0)["name"].decode()
    print(f"worker {cfg.id} ({name}) -> {cfg.coordinator} with {cfg.threads} streams", flush=True)
    threads = [threading.Thread(target=work_loop, args=(gpu, cfg), daemon=True) for _ in range(cfg.threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
