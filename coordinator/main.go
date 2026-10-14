// Coordinator: splits images into tiles, hands them to workers that pull work
// over HTTP, and streams results to browsers over a WebSocket.
//
// Two listeners, never mixed up:
//   - -addr (private, Tailscale only): workers, Wake-on-LAN, unrestricted races.
//   - -public-addr (behind the reverse proxy): the page, live view and races
//     within public limits. Worker and wake endpoints don't exist there.
//
// With -relay, the binary only serves POST /api/wake: it runs on an always-on
// machine of the home LAN so a coordinator elsewhere can wake the PC.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/coder/websocket"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "private listen address (workers, admin)")
	publicAddr := flag.String("public-addr", "", "public listen address, behind a reverse proxy (optional)")
	wake := flag.String("wake", "", "machines this process can wake: machine=mac@broadcast,...")
	wakeRelay := flag.String("wake-relay", "", "URL of a wake relay for the machines listed in -wakeable")
	wakeable := flag.String("wakeable", "", "machines woken through -wake-relay: pc,...")
	relay := flag.Bool("relay", false, "only serve POST /api/wake (Wake-on-LAN relay)")
	flag.Parse()

	waker, err := newWaker(*wake, *wakeRelay, *wakeable)
	if err != nil {
		log.Fatal(err)
	}
	if *relay {
		mux := http.NewServeMux()
		mux.HandleFunc("POST /api/wake", waker.handle)
		log.Printf("wake relay listening on %s", *addr)
		log.Fatal(http.ListenAndServe(*addr, mux))
	}

	hub := NewHub()
	sched := NewScheduler(hub)
	sched.wakeable = waker.machines()
	go sched.Run()

	if *publicAddr != "" {
		go func() {
			log.Printf("public listener on %s", *publicAddr)
			log.Fatal(http.ListenAndServe(*publicAddr, publicRoutes(sched, hub)))
		}()
	}
	log.Printf("coordinator listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, privateRoutes(sched, hub, waker)))
}

func privateRoutes(sched *Scheduler, hub *Hub, waker *waker) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", staticFiles())
	mux.HandleFunc("GET /ws", browserSocket(sched, hub, true))
	mux.HandleFunc("POST /api/races", func(w http.ResponseWriter, r *http.Request) {
		startRace(w, r, sched, nil)
	})
	mux.HandleFunc("POST /api/wake", waker.handle)
	mux.HandleFunc("GET /api/worker/next", func(w http.ResponseWriter, r *http.Request) {
		info, ok := workerFromHeaders(r)
		if !ok {
			http.Error(w, "missing X-Worker-* headers", http.StatusBadRequest)
			return
		}
		tile, ok := sched.Next(r.Context().Done(), info)
		if !ok {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, tile)
	})
	mux.HandleFunc("POST /api/worker/result", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		jobID, err1 := strconv.Atoi(q.Get("job"))
		tileID, err2 := strconv.Atoi(q.Get("tile"))
		computeNs, err3 := strconv.ParseInt(r.Header.Get("X-Compute-Ns"), 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			http.Error(w, "bad job, tile or X-Compute-Ns", http.StatusBadRequest)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 512*512*4+1))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		switch err := sched.Result(jobID, tileID, r.Header.Get("X-Worker-Id"), computeNs, data); {
		case errors.Is(err, errStaleJob):
			w.WriteHeader(http.StatusGone)
		case err != nil:
			http.Error(w, err.Error(), http.StatusBadRequest)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	return mux
}

func publicRoutes(sched *Scheduler, hub *Hub) http.Handler {
	limiter := newPublicLimiter()
	mux := http.NewServeMux()
	mux.Handle("GET /", staticFiles())
	mux.HandleFunc("GET /ws", browserSocket(sched, hub, false))
	mux.HandleFunc("POST /api/races", func(w http.ResponseWriter, r *http.Request) {
		startRace(w, r, sched, limiter)
	})
	return mux
}

func staticFiles() http.Handler {
	static, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	return http.FileServerFS(static)
}

func browserSocket(sched *Scheduler, hub *Hub, admin bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !admin && hub.Count() >= maxPublicViewers {
			http.Error(w, "too many viewers", http.StatusServiceUnavailable)
			return
		}
		// Accept checks that Origin matches Host: other sites can't open a socket.
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := &client{conn: conn, admin: admin}
		ctx := conn.CloseRead(r.Context()) // cancelled when the browser goes away
		sched.Connect(c)
		c.writeLoop(ctx)
		hub.Remove(c)
	}
}

// startRace applies the public limits when limiter is non-nil.
func startRace(w http.ResponseWriter, r *http.Request, sched *Scheduler, limiter *publicLimiter) {
	var spec RaceSpec
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&spec); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if limiter != nil {
		if err := limiter.allow(clientIP(r), spec, sched); err != nil {
			http.Error(w, err.Error(), http.StatusTooManyRequests)
			return
		}
	}
	race, err := sched.StartRace(spec)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]int{"raceId": race.ID})
}

// The public listener only accepts connections from the local reverse proxy,
// which replaces any client-supplied X-Forwarded-For with the real address.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return r.RemoteAddr
}

func workerFromHeaders(r *http.Request) (Worker, bool) {
	id := r.Header.Get("X-Worker-Id")
	threads, _ := strconv.Atoi(r.Header.Get("X-Worker-Threads"))
	if id == "" {
		return Worker{}, false
	}
	return Worker{
		ID:      id,
		Machine: r.Header.Get("X-Worker-Machine"),
		Lang:    r.Header.Get("X-Worker-Lang"),
		Threads: threads,
	}, true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
