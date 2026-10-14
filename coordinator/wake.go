package main

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Wake-on-LAN. A magic packet only travels on the home LAN, so it is sent by a
// process on that LAN: either this coordinator (machines in -wake) or a relay
// that this coordinator calls (machines in -wakeable, through -wake-relay).

type wakeTarget struct {
	mac       net.HardwareAddr
	broadcast string
}

type waker struct {
	local    map[string]wakeTarget
	relayURL string
	relayed  map[string]bool
}

func newWaker(localSpec, relayURL, relayedSpec string) (*waker, error) {
	w := &waker{local: map[string]wakeTarget{}, relayURL: strings.TrimRight(relayURL, "/"), relayed: map[string]bool{}}
	if localSpec != "" {
		// "pc=00:11:22:33:44:55@192.168.1.255,other=..."
		for _, entry := range strings.Split(localSpec, ",") {
			machine, rest, ok1 := strings.Cut(entry, "=")
			macStr, broadcast, ok2 := strings.Cut(rest, "@")
			mac, err := net.ParseMAC(macStr)
			if !ok1 || !ok2 || err != nil {
				return nil, fmt.Errorf("bad wake target %q, want machine=mac@broadcast", entry)
			}
			w.local[machine] = wakeTarget{mac: mac, broadcast: broadcast}
		}
	}
	if relayedSpec != "" {
		if relayURL == "" {
			return nil, fmt.Errorf("-wakeable needs -wake-relay")
		}
		for _, machine := range strings.Split(relayedSpec, ",") {
			w.relayed[machine] = true
		}
	}
	return w, nil
}

func (w *waker) machines() []string {
	var list []string
	for m := range w.local {
		list = append(list, m)
	}
	for m := range w.relayed {
		list = append(list, m)
	}
	return list
}

func (w *waker) handle(rw http.ResponseWriter, r *http.Request) {
	machine := r.URL.Query().Get("machine")
	var err error
	switch {
	case w.local[machine].mac != nil:
		err = sendMagicPacket(w.local[machine])
	case w.relayed[machine]:
		err = w.forward(machine)
	default:
		http.Error(rw, "unknown machine", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("wake %s: %v", machine, err)
		http.Error(rw, "wake failed", http.StatusBadGateway)
		return
	}
	log.Printf("wake sent to %s", machine)
	rw.WriteHeader(http.StatusNoContent)
}

func (w *waker) forward(machine string) error {
	client := http.Client{Timeout: 5 * time.Second}
	res, err := client.Post(w.relayURL+"/api/wake?machine="+url.QueryEscape(machine), "", nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		return fmt.Errorf("relay answered %s", res.Status)
	}
	return nil
}

// A magic packet is 6 bytes of 0xFF followed by the MAC address 16 times,
// sent to the discard port. Go enables SO_BROADCAST on UDP sockets.
func sendMagicPacket(t wakeTarget) error {
	packet := bytes.Repeat([]byte{0xff}, 6)
	for range 16 {
		packet = append(packet, t.mac...)
	}
	conn, err := net.Dial("udp4", net.JoinHostPort(t.broadcast, "9"))
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write(packet)
	return err
}
