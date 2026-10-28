package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A worker sends a large envelope (a skill scan, a 1 MiB file chunk) in
// pieces (reply_chunk), so on a slow uplink its heartbeats, session messages
// and small answers go between them instead of waiting minutes behind one
// message in the single stream. It does so only once the server's
// registered answer lists replyChunksFeature; an older worker sends every
// envelope whole, which this server still takes, and an older server never
// lists the feature, so a newer worker sends it whole.
const replyChunksFeature = "reply_chunks"

// sessionTurnsFeature: this server takes session_turn, the model turns a
// session's agent runs on its own.
const sessionTurnsFeature = "session_turns"

// maxPiecedEnvelopeBytes bounds one envelope sent in pieces as the read
// limit bounds one sent whole.
const maxPiecedEnvelopeBytes = 96 << 20

// maxPartialEnvelopes bounds how many envelopes may be partly received.
const maxPartialEnvelopes = 64

// wsReplyChunkPayload is one piece of an envelope: Data is the next part of
// the envelope's JSON text, Seq counts from 0 and Last marks the final piece.
// ID is the envelope's own id, which a reply shares with its request.
type wsReplyChunkPayload struct {
	ID   string `json:"id"`
	Seq  int    `json:"seq"`
	Last bool   `json:"last,omitempty"`
	Data string `json:"data"`
}

// registeredEnvelope answers a registration. Its payload lists the protocol
// features this server takes ({"features": [...]}); older workers ignore it.
func registeredEnvelope(id string) wsEnvelope {
	return wsEnvelope{
		Type:    wsRegisteredType,
		ID:      id,
		Payload: json.RawMessage(`{"features":["` + replyChunksFeature + `","` + store.DaemonCapabilityWorkspaceFolders + `","` + store.DaemonCapabilityResources + `","` + sessionTurnsFeature + `","reply_chunk_ack","attachment_preview_push","` + runnerReportsFeature + `"]}`),
	}
}

// envelopePieces collects the envelopes a worker sends in pieces. Only the
// connection's read loop uses it, so it needs no lock; it goes with the
// connection.
type envelopePieces struct {
	partial map[string]*partialEnvelope
	bytes   int
}

type partialEnvelope struct {
	next int
	data []byte
}

// add takes one piece. Once the last piece of an envelope arrived it
// returns the whole envelope; a piece out of order, over the bounds or an
// assembled text that is not one valid envelope drops what arrived of it.
func (p *envelopePieces) add(piece wsReplyChunkPayload) (wsEnvelope, bool, error) {
	if piece.ID == "" {
		return wsEnvelope{}, false, errors.New("reply_chunk needs the id of its envelope")
	}
	if p.partial == nil {
		p.partial = map[string]*partialEnvelope{}
	}
	partial := p.partial[piece.ID]
	if partial == nil {
		if piece.Seq != 0 {
			return wsEnvelope{}, false, fmt.Errorf("piece %d of %s came without the pieces before it", piece.Seq, piece.ID)
		}
		if len(p.partial) >= maxPartialEnvelopes {
			return wsEnvelope{}, false, fmt.Errorf("more than %d envelopes are partly received", maxPartialEnvelopes)
		}
		partial = &partialEnvelope{}
		p.partial[piece.ID] = partial
	}
	if piece.Seq != partial.next {
		p.drop(piece.ID)
		return wsEnvelope{}, false, fmt.Errorf("piece %d of %s came after piece %d", piece.Seq, piece.ID, partial.next-1)
	}
	if p.bytes+len(piece.Data) > maxPiecedEnvelopeBytes {
		p.drop(piece.ID)
		return wsEnvelope{}, false, fmt.Errorf("envelope %s is larger than %d bytes", piece.ID, maxPiecedEnvelopeBytes)
	}
	partial.data = append(partial.data, piece.Data...)
	partial.next++
	p.bytes += len(piece.Data)
	if !piece.Last {
		return wsEnvelope{}, false, nil
	}
	data := partial.data
	p.drop(piece.ID)
	var envelope wsEnvelope
	if err := decodeWebSocketEnvelope(data, &envelope); err != nil {
		return wsEnvelope{}, false, fmt.Errorf("envelope %s sent in pieces: %w", piece.ID, err)
	}
	if err := validateWebSocketEnvelope(envelope); err != nil {
		return wsEnvelope{}, false, fmt.Errorf("envelope %s sent in pieces: %w", piece.ID, err)
	}
	if envelope.Type == wsReplyChunkType {
		return wsEnvelope{}, false, fmt.Errorf("envelope %s sent in pieces is itself a piece", piece.ID)
	}
	if envelope.ID != piece.ID {
		return wsEnvelope{}, false, fmt.Errorf("pieces of %s assemble envelope %q", piece.ID, envelope.ID)
	}
	return envelope, true, nil
}

func (p *envelopePieces) drop(id string) {
	if partial := p.partial[id]; partial != nil {
		p.bytes -= len(partial.data)
		delete(p.partial, id)
	}
}

// handleEnvelopePiece takes one reply_chunk and handles the envelope it
// completes as if it had come whole. A broken envelope fails the request
// waiting for it at once instead of at its timeout.
func (c *daemonConnection) handleEnvelopePiece(envelope wsEnvelope) (wsEnvelope, bool, error) {
	var piece wsReplyChunkPayload
	if err := decodeWebSocketPayload(envelope.Payload, &piece); err != nil {
		return wsEnvelope{}, false, err
	}
	whole, complete, err := c.pieces.add(piece)
	if err == nil && c.hasCapability("reply_chunk_ack") {
		payload, _ := json.Marshal(map[string]int{"replyChunkSeq": piece.Seq})
		c.reply(wsEnvelope{Type: wsAckType, ID: piece.ID, Payload: payload})
	}
	if err != nil {
		c.rpc.reject(piece.ID, err)
		return wsEnvelope{}, false, err
	}
	return whole, complete, nil
}
