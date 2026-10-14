package main

import (
	"errors"
	"sync"
	"time"
)

// Limits for races started from the public site. The fleet is a few home
// machines: one visitor must not be able to keep the GPU busy for minutes or
// cancel someone else's race the moment it starts.
const (
	maxPublicViewers  = 200
	maxPublicPixels   = 1920 * 1080
	minPublicTile     = 64
	maxPublicIter     = 65536
	maxPublicSPP      = 64
	maxPublicDepth    = 10
	publicCooldown    = 20 * time.Second // between two races from the same IP
	publicRaceReserve = 60 * time.Second // a running race can't be replaced before this
)

type publicLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func newPublicLimiter() *publicLimiter {
	return &publicLimiter{last: map[string]time.Time{}}
}

func (l *publicLimiter) allow(ip string, spec RaceSpec, sched *Scheduler) error {
	switch {
	case spec.Width*spec.Height > maxPublicPixels:
		return errors.New("résolution max : 1920×1080")
	case spec.TileSize < minPublicTile:
		return errors.New("tuiles de 64 px minimum")
	case spec.Params != nil && spec.Params.MaxIter > maxPublicIter:
		return errors.New("65 536 itérations max")
	case spec.PathTrace != nil && (spec.PathTrace.SPP > maxPublicSPP || spec.PathTrace.MaxDepth > maxPublicDepth):
		return errors.New("64 échantillons par pixel max")
	case sched.RaceRunningFor() < publicRaceReserve:
		return errors.New("une course est en cours, réessaie dans un instant")
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.last[ip]) < publicCooldown {
		return errors.New("attends quelques secondes avant de relancer")
	}
	l.last[ip] = now
	for k, t := range l.last { // keep the map small
		if now.Sub(t) > publicCooldown {
			delete(l.last, k)
		}
	}
	return nil
}
