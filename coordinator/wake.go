package main

import (
	"bytes"
	"fmt"
	"net"
	"strings"
)

// Wake-on-LAN: the coordinator runs on an always-on machine of the LAN, so it can
// wake a sleeping one (the PC) by broadcasting a magic packet.

type wakeTarget struct {
	mac       net.HardwareAddr
	broadcast string
}

// parseWakeTargets reads "pc=00:11:22:33:44:55@192.168.1.255,other=...".
func parseWakeTargets(spec string) (map[string]wakeTarget, error) {
	targets := map[string]wakeTarget{}
	if spec == "" {
		return targets, nil
	}
	for _, entry := range strings.Split(spec, ",") {
		machine, rest, ok1 := strings.Cut(entry, "=")
		macStr, broadcast, ok2 := strings.Cut(rest, "@")
		mac, err := net.ParseMAC(macStr)
		if !ok1 || !ok2 || err != nil {
			return nil, fmt.Errorf("bad wake target %q, want machine=mac@broadcast", entry)
		}
		targets[machine] = wakeTarget{mac: mac, broadcast: broadcast}
	}
	return targets, nil
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
