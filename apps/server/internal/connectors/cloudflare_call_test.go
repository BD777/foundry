package connectors

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
)

// callGateway sends one request through the gateway pipeline as the device's
// loopback forwarder does (the session's stand-in as the bearer, the
// authenticated device beside it) and reads the answer the way the gateway's
// tests assert on it: Cloudflare's answer as data, a refusal as a
// *CloudflareRefusal (or ErrCloudflareHandleExpired), any other failure as an
// error carrying Cloudflare's own codes and messages.
func callGateway(g *CloudflareGateway, handle, deviceID, owner, method, path string, query url.Values, body json.RawMessage) (json.RawMessage, error) {
	target := CloudflareGatewayPath + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader *bytes.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	var request *http.Request
	if reader != nil {
		request = httptest.NewRequest(method, target, reader)
	} else {
		request = httptest.NewRequest(method, target, nil)
	}
	request.Header.Set("Authorization", "Bearer "+handle)
	recorder := httptest.NewRecorder()
	g.Serve(recorder, request, gateway.Device{ID: deviceID, OwnerUserID: owner})
	answer := recorder.Body.Bytes()
	if recorder.Code == http.StatusUnauthorized {
		return nil, ErrCloudflareHandleExpired
	}
	var decoded struct {
		Errors []struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
		Foundry map[string]any `json:"foundry"`
	}
	_ = json.Unmarshal(answer, &decoded)
	if decoded.Foundry != nil {
		refusal := &CloudflareRefusal{Reason: fmt.Sprint(decoded.Foundry["reason"])}
		refusal.Needed, _ = decoded.Foundry["needed"].(string)
		refusal.Current, _ = decoded.Foundry["current"].(string)
		if len(decoded.Errors) > 0 {
			refusal.Message = decoded.Errors[0].Message
		}
		return nil, refusal
	}
	if recorder.Code >= 400 {
		messages := []string{}
		for _, e := range decoded.Errors {
			messages = append(messages, fmt.Sprintf("%d: %s", e.Code, e.Message))
		}
		return nil, fmt.Errorf("HTTP %d: %s", recorder.Code, strings.Join(messages, "; "))
	}
	return json.RawMessage(answer), nil
}
