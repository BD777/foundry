package httpapi

import (
	"fmt"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

// A link can stop carrying data in both directions without either end
// seeing a close (a NAT or Wi-Fi path that silently drops packets). The read
// deadline (daemonReadTimeout, two missed 30 s pings) ends such a connection
// eventually, but until then every request to the device waits its own full
// timeout. So while the server waits for an answer it checks the link: when
// the device has sent nothing at all for daemonProbeAfter, the server pings
// it, and when not one byte comes back within daemonProbeWindow it ends the
// connection. Pending requests then fail at once, the device shows as
// offline, and it reconnects.
//
// Any byte from the device counts, as for the read deadline: a pong, a
// heartbeat, or part of a large message still arriving over a slow uplink.
// A slow but working link therefore never trips it; a healthy idle device
// answers a ping within its round trip, and sends a heartbeat every 25 s
// besides. Nothing is concluded when the ping itself cannot be written in
// time (the server's own downlink is busy).
const (
	daemonProbeAfter  = 15 * time.Second
	daemonProbeWindow = 15 * time.Second
)

// closeNotResponding is why a connection whose device stopped answering is
// ended.
func closeNotResponding(window time.Duration) daemonCloseCause {
	return daemonCloseCause{websocket.CloseGoingAway, fmt.Sprintf("device did not answer a ping within %gs", window.Seconds())}
}

// probeTimings are the liveness check's intervals for this connection's hub.
func (c *daemonConnection) probeTimings() (after, window time.Duration) {
	after, window = daemonProbeAfter, daemonProbeWindow
	if c.hub != nil && c.hub.probeAfter > 0 {
		after = c.hub.probeAfter
	}
	if c.hub != nil && c.hub.probeWindow > 0 {
		window = c.hub.probeWindow
	}
	return after, window
}

// checkWhileWaiting is called periodically while a request waits for the
// device: it starts a probe when the device has been silent long enough.
func (c *daemonConnection) checkWhileWaiting() {
	after, window := c.probeTimings()
	if c.silentFor() < after {
		return
	}
	c.probe(window)
}

// probe pings the device once (one probe at a time per connection) and ends
// the connection when nothing at all arrives from it within window.
func (c *daemonConnection) probe(window time.Duration) {
	if !c.probing.CompareAndSwap(false, true) {
		return
	}
	select {
	case <-c.done:
		c.probing.Store(false)
		return
	default:
	}
	sent := time.Now()
	if err := c.socket.WriteControl(websocket.PingMessage, nil, sent.Add(window)); err != nil {
		c.probing.Store(false)
		return
	}
	time.AfterFunc(window, func() {
		defer c.probing.Store(false)
		if c.lastData.Load() >= sent.UnixNano() {
			return
		}
		deviceID, _ := c.registrationSnapshot()
		cause := closeNotResponding(window)
		log.Printf("daemon connection %s: nothing from the device for %s, none of it since a ping %s ago; closing (%s)", deviceID, c.silentFor().Round(time.Second), window, cause.text)
		c.closeWith(cause)
	})
}
