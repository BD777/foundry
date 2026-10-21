package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in local browser fixture: a temporary database, synthetic accounts and
// application. No external integration, native agent or business job runs.
func TestServiceTunnelBrowserFixture(t *testing.T) {
	directory := os.Getenv("DEV034_BROWSER_FIXTURE")
	if directory == "" {
		t.Skip("opt-in browser fixture")
	}
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>DEV034 synthetic application</title></head><body><h1>Private local service</h1><p id="api">API pending</p><p id="ws">WS pending</p><p id="sse">SSE pending</p><a href="/download">Download evidence</a><a href="/redirect">Local redirect</a><button id="write">Synthetic write</button><p id="write-result"></p><script src="/app.js"></script></body></html>`)
		case "/app.css":
			w.Header().Set("Content-Type", "text/css")
			fmt.Fprint(w, `body{font:18px system-ui;max-width:48rem;margin:2rem auto;padding:1rem;color:#123;background:#eef4ff}button,a{display:block;margin:1rem 0}`)
		case "/app.js":
			w.Header().Set("Content-Type", "text/javascript")
			fmt.Fprint(w, `fetch('/api/check').then(r=>r.json()).then(d=>{document.querySelector('#api').textContent='API: '+d.status;});let ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws');ws.onopen=()=>ws.send('echo');ws.onmessage=e=>document.querySelector('#ws').textContent='WS: '+e.data;ws.onclose=()=>document.querySelector('#ws').textContent='WS: closed';let es=new EventSource('/events');es.onmessage=e=>document.querySelector('#sse').textContent='SSE: '+e.data;es.onerror=()=>document.querySelector('#sse').textContent='SSE: disconnected';document.querySelector('#write').onclick=()=>fetch('/api/write',{method:'POST',body:'synthetic'}).then(r=>r.text()).then(v=>document.querySelector('#write-result').textContent=v);`)
		case "/cookie-set":
			w.Header().Add("Set-Cookie", "session=root; Path=/")
			w.Header().Add("Set-Cookie", "session=account; Path=/account")
			w.Header().Add("Set-Cookie", previewCookie+"=poison; Path=/")
			fmt.Fprint(w, "cookies set")
		case "/cookie-delete":
			w.Header().Add("Set-Cookie", "session=; Path=/account; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
			fmt.Fprint(w, "cookie deleted")
		case "/api/cookies", "/account/cookies":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"cookie": r.Header.Get("Cookie"), "authorization": r.Header.Get("Authorization"), "device": r.Header.Get(deviceCredentialHeader)})
		case "/api/check":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ready"}`)
		case "/api/write":
			if r.Method != "POST" {
				w.WriteHeader(405)
				return
			}
			fmt.Fprint(w, "Synthetic write accepted")
		case "/download":
			w.Header().Set("Content-Disposition", `attachment; filename="dev034-evidence.txt"`)
			fmt.Fprint(w, strings.Repeat("synthetic-evidence\n", 8192))
		case "/redirect":
			http.Redirect(w, r, "http://"+r.Host+"/", 302)
		case "/events":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: ready\n\n")
			w.(http.Flusher).Flush()
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-r.Context().Done():
					return
				case <-ticker.C:
					fmt.Fprint(w, ": alive\n\n")
					w.(http.Flusher).Flush()
				}
			}
		case "/ws":
			ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			for {
				kind, p, err := ws.ReadMessage()
				if err != nil {
					return
				}
				if ws.WriteMessage(kind, p) != nil {
					return
				}
			}
		default:
			http.NotFound(w, r)
		}
	}))
	if os.Getenv("DEV034_BROWSER_SAME_SITE") == "1" {
		f.s.options.PreviewSameSite = true
		f.s.options.PreviewDomain = "foundry.example"
	}
	hash, err := accounts.HashPassword("dev034-local-test")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.store.SetUserPassword(context.Background(), f.userID, hash); err != nil {
		t.Fatal(err)
	}
	other, err := f.s.store.CreateUser(context.Background(), store.NewUser{Username: "other-dev034", PasswordHash: hash, Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.store.SetWorkspaceMember(context.Background(), f.tunnel.WorkspaceID, other.ID, store.WorkspaceRoleMember, f.userID); err != nil {
		t.Fatal(err)
	}
	api, _ := url.Parse(f.server.URL)
	apiProxy := httputil.NewSingleHostReverseProxy(api)
	vite, _ := url.Parse("http://127.0.0.1:38483")
	webProxy := httputil.NewSingleHostReverseProxy(vite)
	edge := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "foundry.example" && !strings.HasPrefix(r.URL.Path, "/api/") {
			if f.s.options.PreviewSameSite {
				controlOriginHeaders(w)
			}
			if dist := os.Getenv("DEV034_BROWSER_WEB_DIST"); dist != "" {
				f.s.serveWeb(dist).ServeHTTP(w, r)
			} else {
				webProxy.ServeHTTP(w, r)
			}
			return
		}
		apiProxy.ServeHTTP(w, r)
	}))
	if port := os.Getenv("DEV034_BROWSER_PORT"); port != "" {
		listener, err := net.Listen("tcp", "127.0.0.1:"+port)
		if err != nil {
			t.Fatal(err)
		}
		edge.Listener.Close()
		edge.Listener = listener
	}
	edge.StartTLS()
	defer edge.Close()
	parsed, _ := url.Parse(edge.URL)
	second := f.tunnel
	second.ID = tunnelRandom()[:32]
	second.HostLabel = newServiceHostLabel("Second")
	second.Name = "Second private application"
	if err := f.s.store.(store.ServiceTunnelStore).CreateServiceTunnel(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	metadata := map[string]any{"secondPreviewURL": f.s.tunnelURL(second), "tlsPort": parsed.Port(), "controlOrigin": accountsTestOrigin, "previewURL": f.s.tunnelURL(f.tunnel), "workspaceId": f.tunnel.WorkspaceID, "serviceId": f.tunnel.ID, "username": "owner-dev_tunnel"}
	if err = os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.MarshalIndent(metadata, "", "  ")
	if err = os.WriteFile(filepath.Join(directory, "fixture.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("synthetic browser fixture ready")
	deadline := time.Now().Add(45 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(filepath.Join(directory, "stop")); err == nil {
			return
		}
		time.Sleep(time.Second)
	}
}
