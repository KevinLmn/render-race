package main

import (
	"encoding/json"
	"math"
)

// Port of workers/rust/src/pathtrace.rs, which is the reference: same operations
// in the same order, so the output is bit-identical.
//
// The Go compiler may fuse a*b+c into one FMA instruction (it does on arm64),
// rounding once instead of twice. Every product that feeds an addition or a
// subtraction therefore goes through m(), whose explicit float64 conversion
// forces the intermediate rounding.
//
// v3 is a struct rather than [3]float64 on purpose: Go's register ABI passes
// small structs in registers but arrays on the stack, which made every vector
// helper a memory round trip (5x slower than Rust before the change).
type v3 struct{ X, Y, Z float64 }

// The scene encodes vectors as [x, y, z].
func (v *v3) UnmarshalJSON(data []byte) error {
	var a [3]float64
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*v = v3{a[0], a[1], a[2]}
	return nil
}

type Scene struct {
	Seed     uint32 `json:"seed"`
	SPP      uint32 `json:"spp"`
	MaxDepth uint32 `json:"maxDepth"`
	Camera   struct {
		Origin     v3 `json:"origin"`
		LowerLeft  v3 `json:"lowerLeft"`
		Horizontal v3 `json:"horizontal"`
		Vertical   v3 `json:"vertical"`
	} `json:"camera"`
	Spheres []sphere `json:"spheres"`
}

type sphere struct {
	C v3      `json:"c"`
	R float64 `json:"r"`
	M uint32  `json:"m"` // 0 lambert, 1 metal, 2 dielectric
	A v3      `json:"a"`
	F float64 `json:"f"`
	I float64 `json:"i"`
}

func m(a, b float64) float64 { return float64(a * b) }

// One RGBA8 pixel per pixel of the tile, row by row.
func renderPathTrace(s *Scene, t *Tile) []byte {
	cam := &s.Camera
	out := make([]byte, 0, t.W*t.H*4)
	width, height := uint32(t.Width), uint32(t.Height)
	for py := uint32(t.Y); py < uint32(t.Y+t.H); py++ {
		for px := uint32(t.X); px < uint32(t.X+t.W); px++ {
			rng := newRng(py*width+px, s.Seed)
			var sum v3
			for range s.SPP {
				u := (float64(px) + rng.f64()) / float64(width)
				v := (float64(height-1-py) + rng.f64()) / float64(height)
				target := add(add(cam.LowerLeft, scale(cam.Horizontal, u)), scale(cam.Vertical, v))
				dir := sub(target, cam.Origin)
				sum = add(sum, rayColor(s, cam.Origin, dir, &rng))
			}
			for _, sk := range [3]float64{sum.X, sum.Y, sum.Z} {
				c := math.Sqrt(sk / float64(s.SPP)) // gamma 2
				if c > 0.999 {
					c = 0.999
				}
				out = append(out, byte(256*c))
			}
			out = append(out, 255)
		}
	}
	return out
}

func rayColor(s *Scene, origin, dir v3, rng *rng) v3 {
	attenuation := v3{1, 1, 1}
	for range s.MaxDepth {
		closest := math.Inf(1)
		hit := -1
		for k := range s.Spheres {
			if t, ok := hitSphere(&s.Spheres[k], origin, dir, 0.001, closest); ok {
				closest = t
				hit = k
			}
		}
		if hit < 0 {
			ud := unit(dir)
			t := 0.5 * (ud.Y + 1)
			sky := v3{(1 - t) + m(t, 0.5), (1 - t) + m(t, 0.7), (1 - t) + m(t, 1.0)}
			return mul(attenuation, sky)
		}

		sp := &s.Spheres[hit]
		p := add(origin, scale(dir, closest))
		outward := v3{(p.X - sp.C.X) / sp.R, (p.Y - sp.C.Y) / sp.R, (p.Z - sp.C.Z) / sp.R}
		front := dot(dir, outward) < 0
		normal := outward
		if !front {
			normal = neg(outward)
		}

		switch sp.M {
		case 0:
			r := unit(randomInUnitSphere(rng))
			dir = add(normal, r)
			attenuation = mul(attenuation, sp.A)
		case 1:
			reflected := reflect(unit(dir), normal)
			r := randomInUnitSphere(rng)
			dir = add(reflected, scale(r, sp.F))
			if dot(dir, normal) <= 0 {
				return v3{}
			}
			attenuation = mul(attenuation, sp.A)
		default:
			ratio := sp.I
			if front {
				ratio = 1 / sp.I
			}
			ud := unit(dir)
			cos := min1(dot(neg(ud), normal))
			sin := math.Sqrt(1 - m(cos, cos))
			// Short-circuit matters: the RNG is only drawn when refraction is possible.
			if m(ratio, sin) > 1 || reflectance(cos, ratio) > rng.f64() {
				dir = reflect(ud, normal)
			} else {
				dir = refract(ud, normal, ratio, cos)
			}
		}
		origin = p
	}
	return v3{}
}

func hitSphere(sp *sphere, origin, dir v3, tMin, tMax float64) (float64, bool) {
	oc := sub(origin, sp.C)
	a := dot(dir, dir)
	halfB := dot(oc, dir)
	c := dot(oc, oc) - m(sp.R, sp.R)
	disc := m(halfB, halfB) - m(a, c)
	if disc < 0 {
		return 0, false
	}
	sq := math.Sqrt(disc)
	root := (-halfB - sq) / a
	if root <= tMin || tMax <= root {
		root = (-halfB + sq) / a
		if root <= tMin || tMax <= root {
			return 0, false
		}
	}
	return root, true
}

func randomInUnitSphere(rng *rng) v3 {
	for {
		x := m(2, rng.f64()) - 1
		y := m(2, rng.f64()) - 1
		z := m(2, rng.f64()) - 1
		p := v3{x, y, z}
		if dot(p, p) < 1 {
			return p
		}
	}
}

func reflect(v, n v3) v3 { return sub(v, scale(n, m(2, dot(v, n)))) }

func refract(uv, n v3, ratio, cos float64) v3 {
	perp := scale(add(uv, scale(n, cos)), ratio)
	parallel := scale(n, -math.Sqrt(math.Abs(1-dot(perp, perp))))
	return add(perp, parallel)
}

// Schlick's approximation, with x^5 as explicit multiplications (no pow).
func reflectance(cos, ior float64) float64 {
	r0 := (1 - ior) / (1 + ior)
	r0 = m(r0, r0)
	x := 1 - cos
	return r0 + m(1-r0, m(m(m(m(x, x), x), x), x))
}

func min1(v float64) float64 {
	if v < 1 {
		return v
	}
	return 1
}

func add(a, b v3) v3           { return v3{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func sub(a, b v3) v3           { return v3{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func mul(a, b v3) v3           { return v3{m(a.X, b.X), m(a.Y, b.Y), m(a.Z, b.Z)} }
func scale(a v3, t float64) v3 { return v3{m(a.X, t), m(a.Y, t), m(a.Z, t)} }
func neg(a v3) v3              { return v3{-a.X, -a.Y, -a.Z} }
func dot(a, b v3) float64      { return m(a.X, b.X) + m(a.Y, b.Y) + m(a.Z, b.Z) }
func unit(a v3) v3 {
	l := math.Sqrt(dot(a, a))
	return v3{a.X / l, a.Y / l, a.Z / l}
}

// PCG-style 32-bit hash generator, see the Rust worker.
type rng uint32

func newRng(pixel, seed uint32) rng {
	r := rng(pixel*0x9E3779B9 ^ seed)
	r.next()
	return r
}

func (r *rng) next() uint32 {
	*r = *r*747796405 + 2891336453
	s := uint32(*r)
	w := ((s >> ((s >> 28) + 4)) ^ s) * 277803737
	return (w >> 22) ^ w
}

// Uniform in [0, 1): 24 random bits, exact in every language's f64.
func (r *rng) f64() float64 { return float64(r.next()>>8) * (1.0 / 16777216.0) }
