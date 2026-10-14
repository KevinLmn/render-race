// Coordinator: splits images into tiles, hands them to workers that pull work
// over HTTP, and streams results to browsers over a WebSocket.
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

	"github.com/coder/websocket"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	hub := NewHub()
	sched := NewScheduler(hub)
	go sched.Run()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := &client{conn: conn, send: make(chan message, clientBuffer)}
		ctx := conn.CloseRead(r.Context()) // cancelled when the browser goes away
		sched.Connect(c)
		c.writeLoop(ctx)
		hub.Remove(c)
	})
	mux.HandleFunc("POST /api/jobs", func(w http.ResponseWriter, r *http.Request) {
		var spec JobSpec
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&spec); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		job, err := sched.StartJob(spec)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, map[string]int{"jobId": job.ID})
	})
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

	log.Printf("coordinator listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
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
