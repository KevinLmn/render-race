package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"sync"
	"time"
)

const (
	// A tile not returned within tileTimeout goes back to the queue: a worker
	// that dies mid-render only costs the tiles it was holding.
	tileTimeout = 10 * time.Second
	// Workers long-poll for tiles; an idle poll returns empty after pollTimeout.
	pollTimeout = 15 * time.Second
	// A worker with no poll for this long is shown as offline.
	onlineGrace = 30 * time.Second
	tickEvery   = 100 * time.Millisecond
)

var (
	errStaleJob = errors.New("tile belongs to a job that is no longer running")
	errBadTile  = errors.New("invalid tile result")
)

type MandelbrotParams struct {
	CenterX float64 `json:"centerX"`
	CenterY float64 `json:"centerY"`
	Scale   float64 `json:"scale"` // complex-plane units per pixel
	MaxIter int     `json:"maxIter"`
}

type JobSpec struct {
	Width    int              `json:"width"`
	Height   int              `json:"height"`
	TileSize int              `json:"tileSize"`
	Params   MandelbrotParams `json:"params"`
	Workers  []string         `json:"workers"` // allowed worker ids, empty = all
}

func (s JobSpec) validate() error {
	switch {
	case s.Width < 64 || s.Width > 3840 || s.Height < 64 || s.Height > 2160:
		return errors.New("resolution must be between 64x64 and 3840x2160")
	case s.TileSize < 32 || s.TileSize > 512:
		return errors.New("tile size must be between 32 and 512")
	case s.Params.MaxIter < 1 || s.Params.MaxIter > 1_000_000:
		return errors.New("maxIter must be between 1 and 1000000")
	case !(s.Params.Scale > 0) || math.IsInf(s.Params.Scale, 0):
		return errors.New("scale must be a positive number")
	}
	return nil
}

// Tile is what a worker receives: everything needed to render it, no shared state.
type Tile struct {
	JobID  int              `json:"jobId"`
	ID     int              `json:"tileId"`
	Kind   string           `json:"kind"`
	X      int              `json:"x"`
	Y      int              `json:"y"`
	W      int              `json:"w"`
	H      int              `json:"h"`
	Width  int              `json:"width"`
	Height int              `json:"height"`
	Params MandelbrotParams `json:"params"`
}

type Worker struct {
	ID       string `json:"id"`
	Machine  string `json:"machine"`
	Lang     string `json:"lang"`
	Threads  int    `json:"threads"`
	Index    int    `json:"index"` // small stable id used in binary tile frames
	Online   bool   `json:"online"`
	lastSeen time.Time
	polling  int
}

type WorkerStats struct {
	Tiles     int   `json:"tiles"`
	Pixels    int   `json:"pixels"`
	ComputeNs int64 `json:"computeNs"`
}

type Job struct {
	ID    int     `json:"id"`
	Spec  JobSpec `json:"spec"`
	Cols  int     `json:"cols"`
	Rows  int     `json:"rows"`
	Total int     `json:"total"`

	pending   []int
	inflight  map[int]assignment
	results   [][]byte
	resultBy  []int
	doneCount int
	requeued  int
	started   time.Time
	firstTile time.Duration
	finished  time.Duration
	stats     map[string]*WorkerStats
	allowed   map[string]bool
	dirty     bool
}

type assignment struct {
	worker   string
	deadline time.Time
}

func (j *Job) tile(id int) Tile {
	ts := j.Spec.TileSize
	x, y := (id%j.Cols)*ts, (id/j.Cols)*ts
	return Tile{
		JobID: j.ID, ID: id, Kind: "mandelbrot",
		X: x, Y: y, W: min(ts, j.Spec.Width-x), H: min(ts, j.Spec.Height-y),
		Width: j.Spec.Width, Height: j.Spec.Height, Params: j.Spec.Params,
	}
}

func (j *Job) done() bool { return j.doneCount == j.Total }

type Scheduler struct {
	mu        sync.Mutex
	hub       *Hub
	job       *Job
	nextJobID int
	workers   map[string]*Worker
	// Closed and replaced on every state change, to wake up long-polling workers.
	changed chan struct{}
}

func NewScheduler(hub *Hub) *Scheduler {
	return &Scheduler{hub: hub, workers: map[string]*Worker{}, changed: make(chan struct{})}
}

func (s *Scheduler) notifyLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *Scheduler) StartJob(spec JobSpec) (*Job, error) {
	if err := spec.validate(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextJobID++
	ts := spec.TileSize
	j := &Job{
		ID: s.nextJobID, Spec: spec,
		Cols: (spec.Width + ts - 1) / ts, Rows: (spec.Height + ts - 1) / ts,
		inflight: map[int]assignment{},
		stats:    map[string]*WorkerStats{},
		started:  time.Now(),
	}
	j.Total = j.Cols * j.Rows
	j.results = make([][]byte, j.Total)
	j.resultBy = make([]int, j.Total)
	for i := range j.resultBy {
		j.resultBy[i] = -1
	}
	if len(spec.Workers) > 0 {
		j.allowed = map[string]bool{}
		for _, id := range spec.Workers {
			j.allowed[id] = true
		}
	}
	// Center-out order: the interesting part of the image shows up first.
	j.pending = make([]int, j.Total)
	for i := range j.pending {
		j.pending[i] = i
	}
	cx, cy := float64(j.Cols-1)/2, float64(j.Rows-1)/2
	dist := func(id int) float64 {
		dx, dy := float64(id%j.Cols)-cx, float64(id/j.Cols)-cy
		return dx*dx + dy*dy
	}
	sort.SliceStable(j.pending, func(a, b int) bool { return dist(j.pending[a]) < dist(j.pending[b]) })

	// Results still in flight for the previous job are rejected as stale.
	s.job = j
	s.notifyLocked()
	s.hub.Broadcast(jsonMessage(map[string]any{"type": "job", "job": j}))
	s.broadcastProgressLocked()
	return j, nil
}

// Next blocks until a tile is available for this worker, or the poll times out.
func (s *Scheduler) Next(done <-chan struct{}, info Worker) (Tile, bool) {
	timer := time.NewTimer(pollTimeout)
	defer timer.Stop()

	s.mu.Lock()
	w := s.touchLocked(info)
	w.polling++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		w.polling--
		w.lastSeen = time.Now()
		s.mu.Unlock()
	}()

	for {
		s.mu.Lock()
		if t, ok := s.assignLocked(w.ID); ok {
			s.mu.Unlock()
			return t, true
		}
		changed := s.changed
		s.mu.Unlock()

		select {
		case <-changed:
		case <-done:
			return Tile{}, false
		case <-timer.C:
			return Tile{}, false
		}
	}
}

func (s *Scheduler) assignLocked(workerID string) (Tile, bool) {
	j := s.job
	if j == nil || len(j.pending) == 0 || (j.allowed != nil && !j.allowed[workerID]) {
		return Tile{}, false
	}
	id := j.pending[0]
	j.pending = j.pending[1:]
	j.inflight[id] = assignment{worker: workerID, deadline: time.Now().Add(tileTimeout)}
	return j.tile(id), true
}

func (s *Scheduler) Result(jobID, tileID int, workerID string, computeNs int64, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	j := s.job
	if j == nil || j.ID != jobID {
		return errStaleJob
	}
	if tileID < 0 || tileID >= j.Total {
		return errBadTile
	}
	t := j.tile(tileID)
	if len(data) != t.W*t.H*4 {
		return errBadTile
	}
	if j.results[tileID] != nil {
		return nil // a requeued tile came back twice: first result wins
	}
	w, ok := s.workers[workerID]
	if !ok {
		return errBadTile
	}

	delete(j.inflight, tileID)
	for i, id := range j.pending { // the tile may have been requeued after a timeout
		if id == tileID {
			j.pending = append(j.pending[:i], j.pending[i+1:]...)
			break
		}
	}
	j.results[tileID] = data
	j.resultBy[tileID] = w.Index
	j.doneCount++
	st := j.stats[workerID]
	if st == nil {
		st = &WorkerStats{}
		j.stats[workerID] = st
	}
	st.Tiles++
	st.Pixels += t.W * t.H
	st.ComputeNs += computeNs
	if j.doneCount == 1 {
		j.firstTile = time.Since(j.started)
	}
	j.dirty = true
	s.hub.Broadcast(tileFrame(j.ID, tileID, w.Index, data))
	if j.done() {
		j.finished = time.Since(j.started)
		s.broadcastProgressLocked()
	}
	return nil
}

// Run requeues expired tiles and pushes throttled progress and presence updates.
func (s *Scheduler) Run() {
	ticker := time.NewTicker(tickEvery)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		if j := s.job; j != nil {
			expired := false
			for id, a := range j.inflight {
				if now.After(a.deadline) {
					delete(j.inflight, id)
					j.pending = append([]int{id}, j.pending...)
					j.requeued++
					j.dirty = true
					expired = true
				}
			}
			if expired {
				s.notifyLocked()
			}
			if j.dirty {
				s.broadcastProgressLocked()
			}
		}
		presenceChanged := false
		for _, w := range s.workers {
			online := w.polling > 0 || now.Sub(w.lastSeen) < onlineGrace
			if online != w.Online {
				w.Online = online
				presenceChanged = true
			}
		}
		if presenceChanged {
			s.broadcastWorkersLocked()
		}
		s.mu.Unlock()
	}
}

func (s *Scheduler) touchLocked(info Worker) *Worker {
	w, ok := s.workers[info.ID]
	if !ok {
		info.Index = len(s.workers)
		w = &info
		s.workers[info.ID] = w
	}
	w.Machine, w.Lang, w.Threads = info.Machine, info.Lang, info.Threads
	w.lastSeen = time.Now()
	if !w.Online {
		w.Online = true
		s.broadcastWorkersLocked()
	}
	return w
}

func (s *Scheduler) broadcastWorkersLocked() {
	s.hub.Broadcast(s.workersMessageLocked())
}

func (s *Scheduler) workersMessageLocked() message {
	list := make([]*Worker, 0, len(s.workers))
	for _, w := range s.workers {
		list = append(list, w)
	}
	sort.Slice(list, func(a, b int) bool { return list[a].Index < list[b].Index })
	return jsonMessage(map[string]any{"type": "workers", "workers": list})
}

func (s *Scheduler) broadcastProgressLocked() {
	s.job.dirty = false
	s.hub.Broadcast(s.progressMessageLocked())
}

func (s *Scheduler) progressMessageLocked() message {
	j := s.job
	elapsed := j.finished
	if !j.done() {
		elapsed = time.Since(j.started)
	}
	stats := make(map[string]WorkerStats, len(j.stats))
	for id, st := range j.stats {
		stats[id] = *st
	}
	return jsonMessage(map[string]any{
		"type":        "progress",
		"jobId":       j.ID,
		"done":        j.doneCount,
		"total":       j.Total,
		"inflight":    len(j.inflight),
		"requeued":    j.requeued,
		"elapsedMs":   ms(elapsed),
		"firstTileMs": ms(j.firstTile),
		"finished":    j.done(),
		"stats":       stats,
	})
}

// Connect registers a browser and replays the current state to it. Holding the
// scheduler lock while registering guarantees it misses no tile.
func (s *Scheduler) Connect(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	initial := []message{s.workersMessageLocked()}
	if j := s.job; j != nil {
		initial = append(initial, jsonMessage(map[string]any{"type": "job", "job": j}))
		for id, data := range j.results {
			if data != nil {
				initial = append(initial, tileFrame(j.ID, id, j.resultBy[id], data))
			}
		}
		initial = append(initial, s.progressMessageLocked())
	}
	s.hub.Add(c, initial)
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func jsonMessage(v any) message {
	data, _ := json.Marshal(v)
	return message{data: data}
}

// tileFrame layout (little endian): jobId u32, tileId u32, workerIndex u16,
// reserved u16, then one u32 iteration count per pixel, row by row.
func tileFrame(jobID, tileID, workerIndex int, data []byte) message {
	frame := make([]byte, 12+len(data))
	binary.LittleEndian.PutUint32(frame[0:], uint32(jobID))
	binary.LittleEndian.PutUint32(frame[4:], uint32(tileID))
	binary.LittleEndian.PutUint16(frame[8:], uint16(workerIndex))
	copy(frame[12:], data)
	return message{data: frame, binary: true}
}
