package main

import (
	"errors"
	"math"
	"math/rand/v2"
)

// Path tracer scene, built once by the coordinator and sent with every tile.
// Workers only use + - * / and sqrt on it (all correctly rounded in IEEE 754),
// so every language and the GPU can produce bit-identical pixels. Anything that
// needs tan or other library math (the camera) is precomputed here.

type Vec3 [3]float64

type Camera struct {
	Origin     Vec3 `json:"origin"`
	LowerLeft  Vec3 `json:"lowerLeft"`
	Horizontal Vec3 `json:"horizontal"`
	Vertical   Vec3 `json:"vertical"`
}

const (
	matLambert    = 0
	matMetal      = 1
	matDielectric = 2
)

type Sphere struct {
	Center   Vec3    `json:"c"`
	Radius   float64 `json:"r"`
	Material int     `json:"m"`
	Albedo   Vec3    `json:"a"`
	Fuzz     float64 `json:"f"`
	IOR      float64 `json:"i"`
}

type Scene struct {
	Seed     uint32   `json:"seed"`
	SPP      int      `json:"spp"`
	MaxDepth int      `json:"maxDepth"`
	Camera   Camera   `json:"camera"`
	Spheres  []Sphere `json:"spheres"`
}

// PathTraceRequest is what a client asks for; the coordinator turns it into a Scene.
type PathTraceRequest struct {
	Preset   string `json:"preset"`
	SPP      int    `json:"spp"`
	MaxDepth int    `json:"maxDepth"`
}

func buildScene(req PathTraceRequest, width, height int) (*Scene, error) {
	if req.SPP < 1 || req.SPP > 1024 {
		return nil, errors.New("spp must be between 1 and 1024")
	}
	if req.MaxDepth < 1 || req.MaxDepth > 64 {
		return nil, errors.New("maxDepth must be between 1 and 64")
	}
	s := &Scene{Seed: 0x5eed, SPP: req.SPP, MaxDepth: req.MaxDepth}
	switch req.Preset {
	case "trio":
		s.Spheres = trioSpheres()
		s.Camera = lookAt(Vec3{0, 1, 5}, Vec3{0, 0.5, -1}, 35, width, height)
	case "marbles", "":
		s.Spheres = marbleSpheres()
		s.Camera = lookAt(Vec3{13, 2, 3}, Vec3{0, 0, 0}, 20, width, height)
	default:
		return nil, errors.New("unknown scene preset")
	}
	return s, nil
}

func trioSpheres() []Sphere {
	return []Sphere{
		{Center: Vec3{0, -1000, -1}, Radius: 1000, Material: matLambert, Albedo: Vec3{0.5, 0.55, 0.45}},
		{Center: Vec3{0, 0.5, -1}, Radius: 0.5, Material: matLambert, Albedo: Vec3{0.85, 0.3, 0.2}},
		{Center: Vec3{-1.05, 0.5, -1}, Radius: 0.5, Material: matDielectric, IOR: 1.5},
		{Center: Vec3{1.05, 0.5, -1}, Radius: 0.5, Material: matMetal, Albedo: Vec3{0.8, 0.7, 0.5}, Fuzz: 0.05},
	}
}

// The cover scene of "Ray Tracing in One Weekend", on a smaller grid.
func marbleSpheres() []Sphere {
	rng := rand.New(rand.NewPCG(42, 7))
	f := rng.Float64
	spheres := []Sphere{
		{Center: Vec3{0, -1000, 0}, Radius: 1000, Material: matLambert, Albedo: Vec3{0.5, 0.5, 0.5}},
	}
	for a := -5; a < 5; a++ {
		for b := -5; b < 5; b++ {
			center := Vec3{float64(a) + 0.9*f(), 0.2, float64(b) + 0.9*f()}
			if math.Hypot(center[0]-4, center[2]) <= 0.9 {
				continue
			}
			switch pick := f(); {
			case pick < 0.7:
				spheres = append(spheres, Sphere{Center: center, Radius: 0.2, Material: matLambert,
					Albedo: Vec3{f() * f(), f() * f(), f() * f()}})
			case pick < 0.9:
				spheres = append(spheres, Sphere{Center: center, Radius: 0.2, Material: matMetal,
					Albedo: Vec3{0.5 + f()/2, 0.5 + f()/2, 0.5 + f()/2}, Fuzz: f() / 2})
			default:
				spheres = append(spheres, Sphere{Center: center, Radius: 0.2, Material: matDielectric, IOR: 1.5})
			}
		}
	}
	return append(spheres,
		Sphere{Center: Vec3{0, 1, 0}, Radius: 1, Material: matDielectric, IOR: 1.5},
		Sphere{Center: Vec3{-4, 1, 0}, Radius: 1, Material: matLambert, Albedo: Vec3{0.4, 0.2, 0.1}},
		Sphere{Center: Vec3{4, 1, 0}, Radius: 1, Material: matMetal, Albedo: Vec3{0.7, 0.6, 0.5}},
	)
}

func lookAt(from, at Vec3, vfovDeg float64, width, height int) Camera {
	h := math.Tan(vfovDeg * math.Pi / 180 / 2)
	viewportH := 2 * h
	viewportW := float64(width) / float64(height) * viewportH
	w := unit(sub(from, at))
	u := unit(cross(Vec3{0, 1, 0}, w))
	v := cross(w, u)
	horizontal := scale(u, viewportW)
	vertical := scale(v, viewportH)
	lowerLeft := sub(sub(sub(from, scale(horizontal, 0.5)), scale(vertical, 0.5)), w)
	return Camera{Origin: from, LowerLeft: lowerLeft, Horizontal: horizontal, Vertical: vertical}
}

func sub(a, b Vec3) Vec3           { return Vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func scale(a Vec3, t float64) Vec3 { return Vec3{a[0] * t, a[1] * t, a[2] * t} }
func unit(a Vec3) Vec3             { return scale(a, 1/math.Sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2])) }
func cross(a, b Vec3) Vec3 {
	return Vec3{a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]}
}
