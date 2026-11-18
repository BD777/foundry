package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personnotice"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	noticeTestChat   = "7207688166424231939"
	noticeTestOrigin = "https://foundry.example"
)

// bundledNotifyDescriptor reads the notify section and routes the way the
// bundled connector declares them, so the tests use the real descriptor.
func bundledNotifyDescriptor(t *testing.T) store.ExtensionInstanceData {
	t.Helper()
	raw, err := os.ReadFile("../../../../extensions/open-lark/foundry-extension.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Connectors []struct {
			ServerHeld store.ConnectorServerHeldSpec `json:"serverHeld"`
		} `json:"connectors"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	spec := manifest.Connectors[0].ServerHeld
	if spec.Notify == nil {
		t.Fatal("the bundled connector has no notify section")
	}
	// The instance is granted writes outright; the descriptor's probe-based
	// access is checked by the acknowledgement path, not here.
	spec.Access = store.ConnectorServerHeldAccess{Allow: []store.ConnectorServerHeldAccessLevel{"write"}}
	return store.ExtensionInstanceData{
		Descriptor: store.ConnectorDescriptor{ServerHeld: &spec},
		Values:     map[string]string{"notifyChat": noticeTestChat},
		Routes: []store.ConnectorServerHeldRoute{
			{Method: "POST", Path: "/agent/v1/conversations/:feedId/messages", Access: "write"},
		},
	}
}

func noticeFixture() store.PersonNotice {
	return store.PersonNotice{
		ID:            "6f1c2d3e-0000-4000-8000-000000000001",
		Title:         `他说"好"`,
		Text:          "第一行\n第二行 \\ 结束，联系 a@b.co",
		Options:       []store.PersonNoticeOption{{ID: "0", Label: "同意"}, {ID: "1", Label: "拒绝"}},
		AllowFreeText: true,
		Link:          "https://foundry.example/pending",
		SinkID:        "ext:app_1",
	}
}

// The bundled send fills the path with the chat and the body with the notice
// id and text: quotes, newlines and Chinese survive as JSON, and the email is
// spelled out before it is sent.
func TestNoticePlanFillsTheBundledSendAsValidJSON(t *testing.T) {
	data := bundledNotifyDescriptor(t)
	notice := noticeFixture()
	request, err := planNoticeRequest(data, notice, noticeTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if request.method != http.MethodPost || request.path != "/agent/v1/conversations/"+noticeTestChat+"/messages" {
		t.Fatalf("send = %s %s", request.method, request.path)
	}
	var body struct {
		ClientID   string `json:"clientId"`
		EditorType string `json:"editorType"`
		Text       string `json:"text"`
	}
	if err := json.Unmarshal(request.body, &body); err != nil {
		t.Fatalf("body is not JSON: %v\n%s", err, request.body)
	}
	if body.ClientID != notice.ID || body.EditorType != "markdown" {
		t.Fatalf("body = %+v", body)
	}
	wantText := personnotice.RenderText(notice) + "\n\n[在 Foundry 中处理](" + notice.Link + ")"
	if body.Text != wantText {
		t.Fatalf("text =\n%q\nwant\n%q", body.Text, wantText)
	}
	if strings.Contains(body.Text, "a@b.co") || !strings.Contains(body.Text, "a [at] b.co") {
		t.Fatalf("the email is not spelled out: %q", body.Text)
	}
	if request.messageIDPointer != "/messageId" {
		t.Fatalf("sent pointer = %q, want /messageId", request.messageIDPointer)
	}
}

// A notice that names no Web address opens the pending items page of the
// server's origin.
func TestNoticeLinkFallsBackToThePendingPage(t *testing.T) {
	notice := noticeFixture()
	notice.Link = ""
	request, err := planNoticeRequest(bundledNotifyDescriptor(t), notice, noticeTestOrigin+"/")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(strings.TrimSpace(string(request.body)), `[在 Foundry 中处理](https://foundry.example/pending)"}`) {
		t.Fatalf("body does not link to the pending page: %s", request.body)
	}
	if _, err := planNoticeRequest(bundledNotifyDescriptor(t), notice, ""); err == nil {
		t.Fatal("a notice with no address and no origin was planned")
	}
}

func TestNoticePlanRefusesWhatTheDescriptorCannotSend(t *testing.T) {
	cases := map[string]func(*store.ExtensionInstanceData){
		"no notify section": func(d *store.ExtensionInstanceData) { d.Descriptor.ServerHeld.Notify = nil },
		"newer notify":      func(d *store.ExtensionInstanceData) { d.Descriptor.ServerHeld.Notify.Version = 2 },
		"no notice chat":    func(d *store.ExtensionInstanceData) { d.Values["notifyChat"] = "  " },
		"route not a write": func(d *store.ExtensionInstanceData) { d.Routes[0].Access = "read" },
		"route not listed":  func(d *store.ExtensionInstanceData) { d.Routes = nil },
	}
	for name, mutate := range cases {
		data := bundledNotifyDescriptor(t)
		mutate(&data)
		if _, err := planNoticeRequest(data, noticeFixture(), noticeTestOrigin); err == nil {
			t.Errorf("%s: a send was planned", name)
		}
	}
}

// The answer's message id is read at the descriptor's pointer. The pointer
// the descriptor used to name (/message/id) does not match the answer.
func TestNoticeAnswerReadsTheSentMessageId(t *testing.T) {
	answer := []byte(`{"messageId":"om_real_1"}`)
	result, err := noticeAnswer(http.StatusAccepted, answer, "/messageId")
	if err != nil || result.ProviderMessageID != "om_real_1" {
		t.Fatalf("noticeAnswer = %+v, %v", result, err)
	}
	_, err = noticeAnswer(http.StatusAccepted, answer, "/message/id")
	if err == nil {
		t.Fatal("a pointer that matches nothing must not count as sent")
	}
	if transient, _ := personnotice.Classify(err); transient {
		t.Fatalf("a missing id is permanent: resending would repeat the notice")
	}
}

func TestNoticeAnswerClassifiesFailures(t *testing.T) {
	audit := []byte(`{"error":{"code":230028,"msg":"The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS"}}`)
	cases := []struct {
		name      string
		status    int
		body      []byte
		transient bool
		ambiguous bool
		sent      bool
	}{
		{name: "accepted", status: 202, body: []byte(`{"messageId":"om_1"}`), sent: true},
		{name: "server error", status: 500, body: []byte("boom"), transient: true},
		{name: "unavailable", status: 503, transient: true},
		{name: "rate limited", status: 429, transient: true},
		{name: "audit rejected", status: 400, body: audit},
		{name: "not found", status: 404, body: []byte(`{}`)},
		{name: "accepted without an id", status: 202, body: []byte(`{}`)},
	}
	for _, tc := range cases {
		result, err := noticeAnswer(tc.status, tc.body, "/messageId")
		if tc.sent {
			if err != nil || result.ProviderMessageID != "om_1" {
				t.Errorf("%s: %+v, %v", tc.name, result, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("%s: no error", tc.name)
			continue
		}
		transient, ambiguous := personnotice.Classify(err)
		if transient != tc.transient || ambiguous != tc.ambiguous {
			t.Errorf("%s: transient=%v ambiguous=%v, want %v %v", tc.name, transient, ambiguous, tc.transient, tc.ambiguous)
		}
	}
	if _, err := noticeAnswer(400, audit, "/messageId"); err == nil || !strings.Contains(err.Error(), "EMAIL_ADDRESS") {
		t.Fatalf("the audit reason is kept for the person: %v", err)
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

var _ net.Error = timeoutError{}

func TestNoticeTransportFailuresAreClassified(t *testing.T) {
	cases := map[string]struct {
		err       error
		transient bool
		ambiguous bool
	}{
		"deadline":        {context.DeadlineExceeded, true, true},
		"network timeout": {timeoutError{}, true, true},
		"unreachable":     {errors.New("dial tcp: connection refused"), true, false},
	}
	for name, tc := range cases {
		transient, ambiguous := personnotice.Classify(classifyNoticeTransport(tc.err))
		if transient != tc.transient || ambiguous != tc.ambiguous {
			t.Errorf("%s: transient=%v ambiguous=%v", name, transient, ambiguous)
		}
	}
}

// httpRequester sends the notice to a test server, as the server-held path
// would send it to the connector's upstream.
func httpRequester(server *httptest.Server) noticeRequester {
	return func(ctx context.Context, method, path string, headers http.Header, body io.Reader) (*http.Response, error) {
		request, err := http.NewRequestWithContext(ctx, method, server.URL+path, body)
		if err != nil {
			return nil, err
		}
		request.Header = headers
		return http.DefaultClient.Do(request)
	}
}

// A resend after a 500 carries the same clientId, so the provider can tell it
// is the same notice; the second answer gives the sent message id.
func TestNoticeResendCarriesTheSameClientID(t *testing.T) {
	var mu sync.Mutex
	var clientIDs []string
	var paths []string
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ClientID string `json:"clientId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		attempts++
		clientIDs = append(clientIDs, body.ClientID)
		paths = append(paths, r.Method+" "+r.URL.Path)
		current := attempts
		mu.Unlock()
		if r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "content type", http.StatusUnsupportedMediaType)
			return
		}
		if current == 1 {
			http.Error(w, "upstream down", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"messageId":"om_real_2"}`))
	}))
	defer server.Close()

	request, err := planNoticeRequest(bundledNotifyDescriptor(t), noticeFixture(), noticeTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sendNotice(context.Background(), request, httpRequester(server)); err == nil {
		t.Fatal("the first attempt succeeded")
	} else if transient, _ := personnotice.Classify(err); !transient {
		t.Fatalf("a 500 is transient: %v", err)
	}
	result, err := sendNotice(context.Background(), request, httpRequester(server))
	if err != nil || result.ProviderMessageID != "om_real_2" {
		t.Fatalf("second attempt = %+v, %v", result, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(clientIDs) != 2 || clientIDs[0] != clientIDs[1] || clientIDs[0] != noticeFixture().ID {
		t.Fatalf("clientIds = %v", clientIDs)
	}
	if paths[0] != "POST /agent/v1/conversations/"+noticeTestChat+"/messages" {
		t.Fatalf("paths = %v", paths)
	}
}

// A send that outlives its deadline may have reached the provider: the failure
// is ambiguous, so the dispatcher resends with the same id and the 1-hour rule
// applies.
func TestNoticeSendThatTimesOutIsAmbiguous(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)

	request, err := planNoticeRequest(bundledNotifyDescriptor(t), noticeFixture(), noticeTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = sendNotice(ctx, request, httpRequester(server))
	transient, ambiguous := personnotice.Classify(err)
	if !transient || !ambiguous {
		t.Fatalf("a timed-out send is ambiguous: transient=%v ambiguous=%v err=%v", transient, ambiguous, err)
	}
}

func TestNoticeSinkIDsResolveOnlyConnectorInstances(t *testing.T) {
	server := &Server{}
	if sink, ok := server.resolveNoticeSink("ext:app_1"); !ok || sink == nil {
		t.Fatal("ext:<instance> resolves to a sink")
	}
	if sink, ok := server.resolveNoticeSink(feishu.NoticeSinkID); !ok || sink == nil {
		t.Fatal("the built-in bot resolves to its sink")
	}
	for _, id := range []string{"", "ext:", "builtin:other", "app_1"} {
		if _, ok := server.resolveNoticeSink(id); ok {
			t.Errorf("%q resolved to a sink", id)
		}
	}
}
