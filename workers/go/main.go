// Go worker: one goroutine per core, each one pulls a tile from the
// coordinator, renders it and posts the result back.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Tile struct {
	JobID  int    `json:"jobId"`
	ID     int    `json:"tileId"`
	Kind   string `json:"kind"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	W      int    `json:"w"`
	H      int    `json:"h"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Params struct {
		CenterX float64 `json:"centerX"`
		CenterY float64 `json:"centerY"`
		Scale   float64 `json:"scale"`
		MaxIter uint32  `json:"maxIter"`
	} `json:"params"`
}

type config struct {
	coordinator, id, machine string
	threads                  int
}

func main() {
	cfg := config{}
	flag.StringVar(&cfg.coordinator, "coordinator", "http://localhost:8080", "coordinator URL")
	flag.StringVar(&cfg.machine, "machine", hostname(), "machine name shown in the UI")
	flag.IntVar(&cfg.threads, "threads", runtime.NumCPU(), "number of tiles rendered in parallel")
	flag.Parse()
	cfg.coordinator = strings.TrimRight(cfg.coordinator, "/")
	cfg.id = cfg.machine + "-go"
	log.Printf("worker %s -> %s with %d threads", cfg.id, cfg.coordinator, cfg.threads)

	client := &http.Client{
		// Longer than the coordinator's long-poll so an idle poll isn't an error.
		Timeout:   30 * time.Second,
		Transport: &http.Transport{MaxIdleConnsPerHost: cfg.threads},
	}
	var wg sync.WaitGroup
	for range cfg.threads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			workLoop(client, cfg)
		}()
	}
	wg.Wait()
}

func workLoop(client *http.Client, cfg config) {
	for {
		tile, err := nextTile(client, cfg)
		if err != nil {
			log.Printf("coordinator unreachable: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}
		if tile == nil {
			continue // poll timed out with no work
		}
		if tile.Kind != "mandelbrot" {
			log.Printf("unsupported tile kind %s", tile.Kind)
			continue
		}

		started := time.Now()
		pixels := renderMandelbrot(tile)
		computeNs := time.Since(started).Nanoseconds()

		url := fmt.Sprintf("%s/api/worker/result?job=%d&tile=%d", cfg.coordinator, tile.JobID, tile.ID)
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(pixels))
		req.Header.Set("X-Worker-Id", cfg.id)
		req.Header.Set("X-Compute-Ns", strconv.FormatInt(computeNs, 10))
		res, err := client.Do(req)
		if err != nil {
			log.Printf("failed to send tile %d: %v", tile.ID, err)
			continue
		}
		res.Body.Close()
		// 410: the job was replaced meanwhile, nothing to do.
		if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusGone {
			log.Printf("tile %d rejected: %s", tile.ID, res.Status)
		}
	}
}

func nextTile(client *http.Client, cfg config) (*Tile, error) {
	req, _ := http.NewRequest(http.MethodGet, cfg.coordinator+"/api/worker/next", nil)
	req.Header.Set("X-Worker-Id", cfg.id)
	req.Header.Set("X-Worker-Machine", cfg.machine)
	req.Header.Set("X-Worker-Lang", "go")
	req.Header.Set("X-Worker-Threads", strconv.Itoa(cfg.threads))
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		var t Tile
		return &t, json.NewDecoder(res.Body).Decode(&t)
	default:
		return nil, fmt.Errorf("unexpected status %s", res.Status)
	}
}

// One little-endian u32 escape iteration count per pixel, row by row.
func renderMandelbrot(t *Tile) []byte {
	p := t.Params
	halfW, halfH := float64(t.Width)/2, float64(t.Height)/2
	out := make([]byte, 0, t.W*t.H*4)
	for py := t.Y; py < t.Y+t.H; py++ {
		cy := p.CenterY + float64((float64(py)+0.5-halfH)*p.Scale)
		for px := t.X; px < t.X+t.W; px++ {
			cx := p.CenterX + float64((float64(px)+0.5-halfW)*p.Scale)
			out = binary.LittleEndian.AppendUint32(out, escapeTime(cx, cy, p.MaxIter))
		}
	}
	return out
}

// The explicit float64() conversions (here and in renderMandelbrot) stop the
// compiler from fusing a*b+c into
// one FMA instruction (it does on arm64). FMA rounds once instead of twice,
// which would make Go disagree with the Rust and JS workers on boundary pixels.
func escapeTime(cx, cy float64, maxIter uint32) uint32 {
	var x, y float64
	var i uint32
	for ; i < maxIter; i++ {
		x2, y2 := float64(x*x), float64(y*y)
		if x2+y2 > 4 {
			break
		}
		y = float64(2*x*y) + cy
		x = x2 - y2 + cx
	}
	return i
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return strings.ToLower(strings.Split(h, ".")[0])
}
