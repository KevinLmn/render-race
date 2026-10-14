//! Path tracer ("Ray Tracing in One Weekend" spheres and materials).
//!
//! Reference implementation for the Go, JS and CUDA ports: they must produce the
//! same bytes. Only + - * / and sqrt are used (correctly rounded in IEEE 754), the
//! RNG is integer-only, and every expression is written in an order the other
//! ports copy exactly. Don't reorder arithmetic here without updating them.

use serde::Deserialize;

type V = [f64; 3];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    seed: u32,
    spp: u32,
    max_depth: u32,
    camera: Camera,
    spheres: Vec<Sphere>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Camera {
    origin: V,
    lower_left: V,
    horizontal: V,
    vertical: V,
}

#[derive(Deserialize)]
struct Sphere {
    c: V,
    r: f64,
    m: u32, // 0 lambert, 1 metal, 2 dielectric
    a: V,
    f: f64,
    i: f64,
}

/// One RGBA8 pixel per pixel of the tile, row by row.
pub fn render(scene: &Scene, x: u32, y: u32, w: u32, h: u32, width: u32, height: u32) -> Vec<u8> {
    let cam = &scene.camera;
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for py in y..y + h {
        for px in x..x + w {
            let mut rng = Rng::new(py.wrapping_mul(width).wrapping_add(px), scene.seed);
            let mut sum = [0.0; 3];
            for _ in 0..scene.spp {
                let u = (px as f64 + rng.next_f64()) / width as f64;
                let v = ((height - 1 - py) as f64 + rng.next_f64()) / height as f64;
                let target = add(add(cam.lower_left, scale(cam.horizontal, u)), scale(cam.vertical, v));
                let dir = sub(target, cam.origin);
                sum = add(sum, ray_color(scene, cam.origin, dir, &mut rng));
            }
            for k in 0..3 {
                let c = (sum[k] / scene.spp as f64).sqrt(); // gamma 2
                let c = if c > 0.999 { 0.999 } else { c };
                out.push((256.0 * c) as u8);
            }
            out.push(255);
        }
    }
    out
}

fn ray_color(scene: &Scene, mut origin: V, mut dir: V, rng: &mut Rng) -> V {
    let mut attenuation = [1.0, 1.0, 1.0];
    for _ in 0..scene.max_depth {
        let mut closest = f64::INFINITY;
        let mut hit = None;
        for (k, s) in scene.spheres.iter().enumerate() {
            if let Some(t) = hit_sphere(s, origin, dir, 0.001, closest) {
                closest = t;
                hit = Some(k);
            }
        }
        let Some(k) = hit else {
            let ud = unit(dir);
            let t = 0.5 * (ud[1] + 1.0);
            let sky = [(1.0 - t) + t * 0.5, (1.0 - t) + t * 0.7, (1.0 - t) + t * 1.0];
            return mul(attenuation, sky);
        };

        let s = &scene.spheres[k];
        let p = add(origin, scale(dir, closest));
        let outward = [(p[0] - s.c[0]) / s.r, (p[1] - s.c[1]) / s.r, (p[2] - s.c[2]) / s.r];
        let front = dot(dir, outward) < 0.0;
        let normal = if front { outward } else { neg(outward) };

        match s.m {
            0 => {
                let r = unit(random_in_unit_sphere(rng));
                dir = add(normal, r);
                attenuation = mul(attenuation, s.a);
            }
            1 => {
                let reflected = reflect(unit(dir), normal);
                let r = random_in_unit_sphere(rng);
                dir = add(reflected, scale(r, s.f));
                if dot(dir, normal) <= 0.0 {
                    return [0.0; 3];
                }
                attenuation = mul(attenuation, s.a);
            }
            _ => {
                let ratio = if front { 1.0 / s.i } else { s.i };
                let ud = unit(dir);
                let cos = min1(dot(neg(ud), normal));
                let sin = (1.0 - cos * cos).sqrt();
                // Short-circuit matters: the RNG is only drawn when refraction is possible.
                dir = if ratio * sin > 1.0 || reflectance(cos, ratio) > rng.next_f64() {
                    reflect(ud, normal)
                } else {
                    refract(ud, normal, ratio, cos)
                };
            }
        }
        origin = p;
    }
    [0.0; 3]
}

fn hit_sphere(s: &Sphere, origin: V, dir: V, t_min: f64, t_max: f64) -> Option<f64> {
    let oc = sub(origin, s.c);
    let a = dot(dir, dir);
    let half_b = dot(oc, dir);
    let c = dot(oc, oc) - s.r * s.r;
    let disc = half_b * half_b - a * c;
    if disc < 0.0 {
        return None;
    }
    let sq = disc.sqrt();
    let mut root = (-half_b - sq) / a;
    if root <= t_min || t_max <= root {
        root = (-half_b + sq) / a;
        if root <= t_min || t_max <= root {
            return None;
        }
    }
    Some(root)
}

fn random_in_unit_sphere(rng: &mut Rng) -> V {
    loop {
        let x = 2.0 * rng.next_f64() - 1.0;
        let y = 2.0 * rng.next_f64() - 1.0;
        let z = 2.0 * rng.next_f64() - 1.0;
        let p = [x, y, z];
        if dot(p, p) < 1.0 {
            return p;
        }
    }
}

fn reflect(v: V, n: V) -> V {
    sub(v, scale(n, 2.0 * dot(v, n)))
}

fn refract(uv: V, n: V, ratio: f64, cos: f64) -> V {
    let perp = scale(add(uv, scale(n, cos)), ratio);
    let parallel = scale(n, -(1.0 - dot(perp, perp)).abs().sqrt());
    add(perp, parallel)
}

/// Schlick's approximation, with x^5 as explicit multiplications (no pow).
fn reflectance(cos: f64, ior: f64) -> f64 {
    let r0 = (1.0 - ior) / (1.0 + ior);
    let r0 = r0 * r0;
    let x = 1.0 - cos;
    r0 + (1.0 - r0) * (x * x * x * x * x)
}

fn min1(v: f64) -> f64 {
    if v < 1.0 { v } else { 1.0 }
}

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, b: V) -> V {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}
fn scale(a: V, t: f64) -> V {
    [a[0] * t, a[1] * t, a[2] * t]
}
fn neg(a: V) -> V {
    [-a[0], -a[1], -a[2]]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit(a: V) -> V {
    let len = dot(a, a).sqrt();
    [a[0] / len, a[1] / len, a[2] / len]
}

/// PCG-style 32-bit hash generator: integer-only, trivially portable to JS and CUDA.
struct Rng(u32);

impl Rng {
    fn new(pixel: u32, seed: u32) -> Self {
        let mut rng = Rng(pixel.wrapping_mul(0x9E37_79B9) ^ seed);
        rng.next_u32();
        rng
    }

    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
        let s = self.0;
        let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277_803_737);
        (w >> 22) ^ w
    }

    /// Uniform in [0, 1): 24 random bits, exact in every language's f64.
    fn next_f64(&mut self) -> f64 {
        (self.next_u32() >> 8) as f64 * (1.0 / 16_777_216.0)
    }
}
