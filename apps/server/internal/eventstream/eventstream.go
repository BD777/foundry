// Package eventstream delivers typed messages to streams of server-sent
// events, in order and resumably. It knows nothing of what the messages
// mean: each kind of message is defined once (Define) by the code that owns
// it, with the payload it carries, and published through that kind only, to
// the streams its route reaches.
package eventstream

// Kind is one message of a stream: its name, the payload P each message of
// it carries, and how it bears on cached snapshots. Kinds are defined once,
// at package level, by the code that owns them.
type Kind[P any] struct {
	name          string
	keepsSnapshot bool
}

// Options say how a kind's messages bear on the data the server serves.
type Options struct {
	// KeepsSnapshot: a message of the kind changes nothing a snapshot of
	// the data serves, so publishing it keeps the snapshot revision (see
	// Hub.Revision). Every other message invalidates snapshots.
	KeepsSnapshot bool
}

// Define is the kind of message named name, carrying P.
func Define[P any, N ~string](name N, options Options) Kind[P] {
	if name == "" {
		panic("eventstream: a kind needs a name")
	}
	return Kind[P]{name: string(name), keepsSnapshot: options.KeepsSnapshot}
}

// Name is the kind's name, its messages' "type".
func (k Kind[P]) Name() string {
	return k.name
}

// Publish sends payload as a message of the kind to the streams route
// reaches.
func (k Kind[P]) Publish(to Publisher, route Route, payload P) {
	to.publish(publication{kind: k.name, route: route, payload: payload, keepsSnapshot: k.keepsSnapshot})
}

// Message is payload as a message of the kind outside any route: what a
// hub sends a stream about itself (see Control).
func (k Kind[P]) Message(payload P) Message {
	return Message{Type: k.name, Payload: payload}
}

// Route names the streams a message reaches: those whose Reach receives its
// workspace, or every stream. A message of no workspace (Workspace "")
// reaches only the streams that receive that too, which is not Everyone.
type Route struct {
	Workspace string
	// Everyone: every stream, whatever it may see; for messages that carry
	// no data.
	Everyone bool
}

// Publisher takes published messages: the hub, which delivers them.
// Nothing else implements it: messages are published only through their
// Kind.
type Publisher interface {
	publish(publication)
}

// publication is one message as its Kind publishes it.
type publication struct {
	kind          string
	route         Route
	payload       any
	keepsSnapshot bool
}

// Message is a message as it is written: its envelope's type and payload.
type Message struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}
