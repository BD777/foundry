package externalaccounts

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

const (
	extensionSecretVersion      = 1
	extensionProbeLimit         = 2 << 20
	extensionErrorLimit         = 64 << 10
	extensionTokenLimit         = 8 << 10
	extensionProbeTimeout       = 30 * time.Second
	extensionDefaultTimeout     = 60 * time.Second
	extensionDefaultRequestMax  = 8 << 20
	extensionDefaultResponseMax = 16 << 20
	ExtensionNetworkServer      = "server"
	ExtensionNetworkDevice      = "device"
)

var (
	ErrInvalidExtensionInstance = errors.New("invalid connector extension instance")
	errExtensionRedirect        = errors.New("connector extension redirects are not followed")
)

type ExtensionProbeError struct {
	Class   string
	Status  int
	Message string
	Err     error
}

func (e *ExtensionProbeError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "connector extension probe failed"
}

func (e *ExtensionProbeError) Unwrap() error { return e.Err }

// ExtensionDeviceHTTPRequest is one upstream exchange delegated to a device.
// Headers can contain a rendered secret and must never be logged or persisted.
type ExtensionDeviceHTTPRequest struct {
	Method         string
	URL            string
	Headers        map[string]string
	Body           []byte
	TimeoutSeconds int
}

type ExtensionDeviceHTTPResponse struct {
	Status  int
	Headers http.Header
	Body    []byte
}

type ExtensionResolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

type ExtensionClient struct {
	Resolver      ExtensionResolver
	Now           func() time.Time
	Timeout       time.Duration
	client        *http.Client
	allowInsecure bool
}

type extensionEndpoint struct {
	base  *url.URL
	host  string
	port  string
	addrs []netip.Addr
	// deviceID is set for an instance whose request leaves through a device.
	deviceID string
}

type extensionSecretPayload struct {
	Version int               `json:"version"`
	Values  map[string]string `json:"values"`
}

func ExtensionSecretID(appID string) string {
	return "external-app:" + appID + ":extension"
}

func (s *Service) extensionStore() (store.ExtensionServerHeldStore, error) {
	st, ok := any(s.store).(store.ExtensionServerHeldStore)
	if !ok {
		return nil, errors.New("this server store does not hold connector extension instances")
	}
	return st, nil
}

func (s *Service) extensionClient() *ExtensionClient {
	if s.Extensions == nil {
		s.Extensions = &ExtensionClient{}
	}
	return s.Extensions
}

func (c *ExtensionClient) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *ExtensionClient) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return extensionProbeTimeout
}

func (c *ExtensionClient) resolver() ExtensionResolver {
	if c.Resolver != nil {
		return c.Resolver
	}
	return net.DefaultResolver
}

func (c *ExtensionClient) endpoint(ctx context.Context, rawURL string) (*extensionEndpoint, error) {
	return c.endpointForNetwork(ctx, rawURL, ExtensionNetworkServer, "")
}

func (c *ExtensionClient) endpointForNetwork(ctx context.Context, rawURL, network, deviceID string) (*extensionEndpoint, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "enter a complete server URL"}
	}
	serverNetwork := network == ExtensionNetworkServer
	if serverNetwork && !c.allowInsecure && parsed.Scheme != "https" {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "the server path requires an HTTPS address"}
	}
	if (!serverNetwork || c.allowInsecure) && parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "enter a complete HTTP(S) server URL"}
	}
	if parsed.User != nil {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "the server URL must not contain credentials"}
	}
	if parsed.RawQuery != "" {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "the server URL must not contain a query string"}
	}
	if parsed.Fragment != "" {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "the server URL must not contain a fragment"}
	}
	if extensionPathUnsafe(parsed.Path) {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "the server URL path must not contain traversal or control characters"}
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "" {
		return nil, &ExtensionProbeError{Class: "url_invalid", Message: "enter a complete server URL"}
	}
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	base := *parsed
	base.Path = strings.TrimRight(parsed.Path, "/")
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	if !serverNetwork {
		return &extensionEndpoint{base: &base, host: host, port: port, deviceID: deviceID}, nil
	}
	var addrs []netip.Addr
	if literal, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{literal.Unmap()}
	} else {
		resolved, err := c.resolver().LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, &ExtensionProbeError{Class: "dns_failed", Message: "the server host name could not be resolved", Err: err}
		}
		for _, addr := range resolved {
			addrs = append(addrs, addr.Unmap())
		}
	}
	if len(addrs) == 0 {
		return nil, &ExtensionProbeError{Class: "dns_failed", Message: "the server host name resolved to no address"}
	}
	if !c.allowInsecure {
		for _, addr := range addrs {
			if !publicExtensionAddr(addr) {
				return nil, &ExtensionProbeError{
					Class: "ssrf_blocked",
					Message: fmt.Sprintf(
						"%s is a private or reserved address, so the Foundry server cannot reach it. Choose 'Via a device' and select a device on that network",
						host,
					),
				}
			}
		}
	}
	return &extensionEndpoint{base: &base, host: host, port: port, addrs: addrs}, nil
}

func extensionPathUnsafe(path string) bool {
	if strings.ContainsAny(path, "\\\x00\r\n") {
		return true
	}
	for _, segment := range strings.Split(path, "/") {
		decoded, err := url.PathUnescape(segment)
		if err != nil || decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "\\\x00\r\n") {
			return true
		}
	}
	return false
}

var extensionBlockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func publicExtensionAddr(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() || addr.IsLoopback() || addr.IsPrivate() ||
		addr.IsMulticast() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsInterfaceLocalMulticast() {
		return false
	}
	for _, prefix := range extensionBlockedPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func (e *extensionEndpoint) clientFor(base *http.Client, allowInsecure bool, timeout time.Duration) *http.Client {
	checkRedirect := func(*http.Request, []*http.Request) error { return errExtensionRedirect }
	if base != nil {
		copied := *base
		copied.CheckRedirect = checkRedirect
		return &copied
	}
	if allowInsecure {
		return &http.Client{Timeout: timeout, CheckRedirect: checkRedirect}
	}
	address := net.JoinHostPort(e.addrs[0].String(), e.port)
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, address)
		},
		TLSClientConfig:     &tls.Config{ServerName: e.host, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        4,
		IdleConnTimeout:     30 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: checkRedirect}
}

func (e *extensionEndpoint) URL(path string) string {
	return strings.TrimRight(e.base.String(), "/") + "/" + strings.TrimLeft(path, "/")
}

func normalizeExtensionInput(input store.ConnectorServerHeldInstanceInput) store.ConnectorServerHeldInstanceInput {
	input.Label = strings.TrimSpace(input.Label)
	input.Network = strings.TrimSpace(input.Network)
	input.DeviceID = strings.TrimSpace(input.DeviceID)
	if input.Fields == nil {
		input.Fields = map[string]string{}
	}
	return input
}

func extensionNetwork(descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput) (string, error) {
	if descriptor.ServerHeld == nil {
		return "", fmt.Errorf("%w: connector has no serverHeld declaration", ErrInvalidExtensionInstance)
	}
	network := input.Network
	if network == "" {
		network = ExtensionNetworkServer
	}
	allowed := false
	for _, holding := range descriptor.ServerHeld.Network.Holdings {
		allowed = allowed || holding == network
	}
	if !allowed {
		return "", fmt.Errorf("%w: this connector does not allow the %s network path", ErrInvalidExtensionInstance, network)
	}
	if network == ExtensionNetworkDevice && input.DeviceID == "" {
		return "", fmt.Errorf("%w: choose the device that validates this instance", ErrInvalidExtensionInstance)
	}
	return network, nil
}

func extensionFieldValues(descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput, existingSecrets map[string]string, allowMissingSecrets bool) (map[string]string, []string, error) {
	serverHeld := descriptor.ServerHeld
	if serverHeld == nil {
		return nil, nil, fmt.Errorf("%w: connector has no serverHeld declaration", ErrInvalidExtensionInstance)
	}
	values := map[string]string{}
	secrets := map[string]string{}
	known := map[string]store.ConnectorField{}
	for _, field := range serverHeld.Fields {
		known[field.ID] = field
	}
	for id := range input.Fields {
		if _, ok := known[id]; !ok {
			return nil, nil, fmt.Errorf("%w: unknown field %q", ErrInvalidExtensionInstance, id)
		}
	}
	for _, field := range serverHeld.Fields {
		value := strings.TrimSpace(input.Fields[field.ID])
		if value == "" {
			value = field.Default
		}
		if field.Type == "secret" {
			if value == "" {
				value = existingSecrets[field.ID]
			}
			if field.Required && value == "" && !allowMissingSecrets {
				return nil, nil, fmt.Errorf("%w: %s is required", ErrInvalidExtensionInstance, field.ID)
			}
			if value != "" {
				if len(value) > extensionTokenLimit {
					return nil, nil, fmt.Errorf("%w: %s is too long", ErrInvalidExtensionInstance, field.ID)
				}
				secrets[field.ID] = value
			}
			continue
		}
		if field.Required && value == "" {
			return nil, nil, fmt.Errorf("%w: %s is required", ErrInvalidExtensionInstance, field.ID)
		}
		if field.Pattern != "" && value != "" {
			pattern, err := regexp.Compile(field.Pattern)
			if err != nil || !pattern.MatchString(value) {
				return nil, nil, fmt.Errorf("%w: %s does not match its pattern", ErrInvalidExtensionInstance, field.ID)
			}
		}
		if field.Type == "select" && value != "" && field.OptionsFrom == "" {
			found := false
			for _, option := range field.Options {
				found = found || option.Value == value
			}
			if !found {
				return nil, nil, fmt.Errorf("%w: %s is not one of its options", ErrInvalidExtensionInstance, field.ID)
			}
		}
		values[field.ID] = value
	}
	if len(input.Label) > 160 {
		return nil, nil, fmt.Errorf("%w: the label is longer than 160 characters", ErrInvalidExtensionInstance)
	}
	ids := make([]string, 0, len(secrets))
	for id := range secrets {
		ids = append(ids, id)
	}
	return values, ids, nil
}

func (s *Service) ProbeExtensionInstance(ctx context.Context, descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput, existingSecrets map[string]string) (store.ConnectorServerHeldProbeResult, error) {
	if err := s.Integrations.Err(); err != nil {
		return store.ConnectorServerHeldProbeResult{}, err
	}
	input = normalizeExtensionInput(input)
	network, err := extensionNetwork(descriptor, input)
	if err != nil {
		return store.ConnectorServerHeldProbeResult{}, err
	}
	values, _, err := extensionFieldValues(descriptor, input, existingSecrets, false)
	if err != nil {
		return store.ConnectorServerHeldProbeResult{}, err
	}
	secrets := map[string]string{}
	for _, field := range descriptor.ServerHeld.Fields {
		if field.Type == "secret" {
			if value := strings.TrimSpace(input.Fields[field.ID]); value != "" {
				secrets[field.ID] = value
			} else if existingSecrets[field.ID] != "" {
				secrets[field.ID] = existingSecrets[field.ID]
			}
		}
	}
	probed, _, err := s.probeExtension(ctx, descriptor, network, input.DeviceID, values, secrets)
	if err != nil {
		return store.ConnectorServerHeldProbeResult{}, err
	}
	probed.Values = jsonempty.Map[string](nonNilMap(probed.Values))
	probed.SecretFields = jsonempty.List[string](jsonemptyList(probed.SecretFields))
	probed.ProbeValues = jsonempty.Map[string](nonNilMap(probed.ProbeValues))
	if probed.FieldOptions == nil {
		probed.FieldOptions = jsonempty.Map[store.ConnectorOptionList]{}
	}
	return probed, nil
}

func (s *Service) probeExtension(ctx context.Context, descriptor store.ConnectorDescriptor, network, deviceID string, values, secrets map[string]string) (store.ConnectorServerHeldProbeResult, []store.ConnectorServerHeldRoute, error) {
	serverHeld := descriptor.ServerHeld
	if serverHeld == nil {
		return store.ConnectorServerHeldProbeResult{}, nil, fmt.Errorf("%w: connector has no serverHeld declaration", ErrInvalidExtensionInstance)
	}
	client := s.extensionClient()
	baseURL := extensionBaseURL(serverHeld, values[serverHeld.Upstream.BaseField])
	endpoint, err := client.endpointForNetwork(ctx, baseURL, network, deviceID)
	if err != nil {
		return store.ConnectorServerHeldProbeResult{}, nil, err
	}
	var httpClient *http.Client
	if endpoint.deviceID == "" {
		httpClient = endpoint.clientFor(client.client, client.allowInsecure, client.timeout())
	}
	probeCtx, cancel := context.WithTimeout(ctx, client.timeout())
	defer cancel()
	result := store.ConnectorServerHeldProbeResult{
		Values:        jsonempty.Map[string](nonNilMap(values)),
		SecretFields:  jsonempty.List[string](secretFieldIDs(serverHeld.Fields, secrets)),
		ProbeValues:   jsonempty.Map[string]{},
		FieldOptions:  jsonempty.Map[store.ConnectorOptionList]{},
		Network:       network,
		ProbeDeviceID: deviceID,
	}
	var routes []store.ConnectorServerHeldRoute
	for _, probe := range serverHeld.Probe {
		payload, _, err := s.extensionJSON(probeCtx, httpClient, endpoint, probe.Method, probe.Path, serverHeld.Upstream.Headers, values, secrets, extensionProbeLimit)
		if err != nil {
			var probeErr *ExtensionProbeError
			if probe.Optional && errors.As(err, &probeErr) && probeErr.Status == http.StatusNotFound {
				continue
			}
			return store.ConnectorServerHeldProbeResult{}, nil, err
		}
		var document any
		if err := json.Unmarshal(payload, &document); err != nil {
			return store.ConnectorServerHeldProbeResult{}, nil, &ExtensionProbeError{Class: "bad_response", Message: "the connector returned non-JSON during its probe", Err: err}
		}
		for name, pointer := range probe.Extract.Values {
			if value, ok := extensionJSONValue(document, pointer); ok {
				result.ProbeValues[name] = extensionScalar(value)
				result.ProbeValues[probe.ID+"/"+name] = extensionScalar(value)
				if name == "version" && result.Version == "" {
					result.Version = extensionScalar(value)
				}
			}
		}
		if probe.Extract.Options.Items != "" {
			options, err := extensionOptions(document, probe.Extract.Options)
			if err != nil {
				return store.ConnectorServerHeldProbeResult{}, nil, fmt.Errorf("probe %s: %w", probe.ID, err)
			}
			for _, field := range serverHeld.Fields {
				if field.OptionsFrom == "probe:"+probe.ID {
					result.FieldOptions[field.ID] = store.ConnectorOptionList(options)
				}
			}
		}
		if probe.Extract.Routes.Items != "" {
			routes, err = extensionRoutes(document, probe.Extract.Routes)
			if err != nil {
				return store.ConnectorServerHeldProbeResult{}, nil, fmt.Errorf("probe %s: %w", probe.ID, err)
			}
		}
	}
	if strings.HasPrefix(serverHeld.Access.From, "probe:") {
		probeID := strings.TrimPrefix(serverHeld.Access.From, "probe:")
		if probeID == "" {
			return store.ConnectorServerHeldProbeResult{}, nil, fmt.Errorf("%w: access names no probe", ErrInvalidExtensionInstance)
		}
	}
	if len(routes) == 0 {
		return store.ConnectorServerHeldProbeResult{}, nil, &ExtensionProbeError{Class: "bad_response", Message: "the connector returned no route directory"}
	}
	if ExtensionAccessLevel(serverHeld.Access, result.ProbeValues) == "" {
		return store.ConnectorServerHeldProbeResult{}, nil, &ExtensionProbeError{
			Class: "bad_response", Message: "the connector token grants no route access declared by this extension",
		}
	}
	result.RouteCount = len(routes)
	if network == ExtensionNetworkDevice {
		if s.ExtensionCheckDevices == nil {
			return store.ConnectorServerHeldProbeResult{}, nil, errors.New("this server cannot check extension devices")
		}
		devices, checkErr := s.ExtensionCheckDevices(ctx, descriptor, values[serverHeld.Upstream.BaseField], deviceID)
		if checkErr != nil {
			return store.ConnectorServerHeldProbeResult{}, nil, checkErr
		}
		result.AvailableDevices = devices
	}
	for _, field := range serverHeld.Fields {
		if field.OptionsFrom == "" {
			continue
		}
		options := result.FieldOptions[field.ID]
		value := values[field.ID]
		if value == "" {
			continue
		}
		found := false
		for _, option := range options {
			found = found || option.Value == value
		}
		if !found {
			return store.ConnectorServerHeldProbeResult{}, nil, fmt.Errorf("%w: %s is not one of the probed options", ErrInvalidExtensionInstance, field.ID)
		}
	}
	return result, routes, nil
}

func secretFieldIDs(fields []store.ConnectorField, secrets map[string]string) []string {
	var ids []string
	for _, field := range fields {
		if field.Type == "secret" && secrets[field.ID] != "" {
			ids = append(ids, field.ID)
		}
	}
	return ids
}

func (s *Service) extensionJSON(ctx context.Context, client *http.Client, endpoint *extensionEndpoint, method, path string, headerTemplates map[string]string, values, secrets map[string]string, limit int64) ([]byte, string, error) {
	request, err := http.NewRequestWithContext(ctx, method, endpoint.URL(path), nil)
	if err != nil {
		return nil, "", &ExtensionProbeError{Class: "url_invalid", Message: "the connector probe URL is invalid", Err: err}
	}
	request.Header.Set("Accept", "application/json, application/*+json")
	request.Header.Set("User-Agent", "Foundry-Connector/1.0")
	for name, template := range headerTemplates {
		value := renderExtensionTemplate(template, values, secrets, nil, false)
		if value != "" {
			request.Header.Set(name, value)
		}
	}
	var response *http.Response
	if endpoint.deviceID != "" {
		if s.ExtensionDeviceRequest == nil {
			return nil, "", errors.New("this server cannot forward extension requests through a device")
		}
		response, err = s.doDeviceExtensionRequest(ctx, endpoint.deviceID, request)
	} else {
		response, err = client.Do(request)
	}
	if err != nil {
		return nil, "", classifyExtensionTransportError(err)
	}
	defer response.Body.Close()
	bodyLimit := limit
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		bodyLimit = extensionErrorLimit
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, bodyLimit+1))
	if readErr != nil {
		return nil, "", &ExtensionProbeError{Class: "bad_response", Message: "the connector response could not be read", Err: readErr}
	}
	if int64(len(payload)) > bodyLimit {
		return nil, "", &ExtensionProbeError{Class: "bad_response", Message: "the connector response is larger than Foundry accepts", Status: response.StatusCode}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", extensionStatusError(response.StatusCode, payload)
	}
	return payload, strings.TrimSpace(response.Header.Get("ETag")), nil
}

func (s *Service) doDeviceExtensionRequest(ctx context.Context, deviceID string, request *http.Request) (*http.Response, error) {
	headers := map[string]string{}
	for name, values := range request.Header {
		if len(values) > 0 {
			headers[name] = strings.Join(values, ", ")
		}
	}
	timeoutSeconds := 60
	if deadline, ok := request.Context().Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, context.DeadlineExceeded
		}
		if seconds := int((remaining + time.Second - 1) / time.Second); seconds < timeoutSeconds {
			timeoutSeconds = seconds
		}
	}
	var body []byte
	if request.GetBody != nil {
		read, err := request.GetBody()
		if err != nil {
			return nil, err
		}
		body, err = io.ReadAll(read)
		_ = read.Close()
		if err != nil {
			return nil, err
		}
	} else if request.Body != nil {
		read, err := io.ReadAll(request.Body)
		_ = request.Body.Close()
		if err != nil {
			return nil, err
		}
		request.Body = io.NopCloser(bytes.NewReader(read))
		body = read
	}
	answer, err := s.ExtensionDeviceRequest(ctx, deviceID, ExtensionDeviceHTTPRequest{
		Method: request.Method, URL: request.URL.String(), Headers: headers,
		Body:           body,
		TimeoutSeconds: timeoutSeconds,
	})
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: answer.Status,
		Header:     answer.Headers,
		Body:       io.NopCloser(strings.NewReader(string(answer.Body))),
		Request:    request,
	}, nil
}

func classifyExtensionTransportError(err error) error {
	var probeErr *ExtensionProbeError
	if errors.As(err, &probeErr) {
		return probeErr
	}
	if errors.Is(err, errExtensionRedirect) {
		return &ExtensionProbeError{Class: "redirect_refused", Message: "the connector answered with a redirect; redirects are not followed", Err: err}
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return &ExtensionProbeError{Class: "timeout", Message: "the connector did not answer before the timeout", Err: err}
	}
	var verification *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	if errors.As(err, &verification) || errors.As(err, &record) || strings.Contains(err.Error(), "certificate") || strings.Contains(err.Error(), "x509") {
		return &ExtensionProbeError{Class: "tls_error", Message: "Foundry could not verify the connector server's TLS certificate", Err: err}
	}
	return &ExtensionProbeError{Class: "unreachable", Message: "Foundry could not reach the connector server", Err: err}
}

func extensionStatusError(status int, payload []byte) *ExtensionProbeError {
	message := extensionErrorMessage(payload)
	probeErr := &ExtensionProbeError{Status: status}
	switch {
	case status == http.StatusUnauthorized:
		probeErr.Class, probeErr.Message = "unauthorized", "the connector rejected the credential"
	case status == http.StatusForbidden:
		probeErr.Class, probeErr.Message = "forbidden", "the connector refused this credential"
	case status == http.StatusNotFound:
		probeErr.Class, probeErr.Message = "not_found", "the server URL did not answer the connector's probe"
	case status >= 300 && status < 400:
		probeErr.Class, probeErr.Message = "redirect_refused", "the connector answered with a redirect; redirects are not followed"
	case status >= 500:
		probeErr.Class, probeErr.Message = "unavailable", "the connector is not ready; try again shortly"
	default:
		probeErr.Class, probeErr.Message = "bad_response", "the connector refused the probe"
	}
	if message != "" {
		probeErr.Message += ": " + message
	}
	return probeErr
}

func extensionErrorMessage(payload []byte) string {
	var document any
	if json.Unmarshal(payload, &document) != nil {
		return ""
	}
	var message string
	if object, ok := document.(map[string]any); ok {
		if errObject, ok := object["error"].(map[string]any); ok {
			if text, ok := errObject["message"].(string); ok {
				message = text
				if code, ok := errObject["code"].(string); ok && code != "" {
					message = code + ": " + message
				}
			}
		}
	}
	message = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, message)), " ")
	if len(message) > 300 {
		message = message[:300]
	}
	return message
}

func extensionJSONValue(document any, pointer string) (any, bool) {
	if pointer == "" {
		return document, true
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, false
	}
	current := document
	for _, token := range strings.Split(pointer[1:], "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		switch value := current.(type) {
		case map[string]any:
			next, ok := value[token]
			if !ok {
				return nil, false
			}
			current = next
		case []any:
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(value) {
				return nil, false
			}
			current = value[index]
		default:
			return nil, false
		}
	}
	return current, true
}

func extensionScalar(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return ""
	}
}

func extensionOptions(document any, extract store.ConnectorServerHeldOptionsExtract) ([]store.ConnectorOption, error) {
	raw, ok := extensionJSONValue(document, extract.Items)
	if !ok {
		return nil, errors.New("options path does not name an array")
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, errors.New("options path does not name an array")
	}
	options := make([]store.ConnectorOption, 0, len(items))
	for _, item := range items {
		valueRaw, okValue := extensionJSONValue(item, extract.Value)
		labelRaw, okLabel := extensionJSONValue(item, extract.Label)
		value, label := extensionScalar(valueRaw), extensionScalar(labelRaw)
		if !okValue || !okLabel || value == "" || label == "" {
			continue
		}
		options = append(options, store.ConnectorOption{Value: value, Label: label})
	}
	if len(options) == 0 {
		return nil, errors.New("options extraction produced no choices")
	}
	return options, nil
}

func extensionRoutes(document any, extract store.ConnectorServerHeldRoutesExtract) ([]store.ConnectorServerHeldRoute, error) {
	raw, ok := extensionJSONValue(document, extract.Items)
	if !ok {
		return nil, errors.New("route path does not name an array")
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, errors.New("route path does not name an array")
	}
	routes := make([]store.ConnectorServerHeldRoute, 0, len(items))
	for _, item := range items {
		methodRaw, _ := extensionJSONValue(item, extract.Method)
		pathRaw, _ := extensionJSONValue(item, extract.Path)
		accessRaw, _ := extensionJSONValue(item, extract.Access)
		domainRaw, _ := extensionJSONValue(item, extract.Domain)
		route := store.ConnectorServerHeldRoute{
			Method: strings.ToUpper(extensionScalar(methodRaw)),
			Path:   extensionScalar(pathRaw),
			Access: strings.ToLower(extensionScalar(accessRaw)),
			Domain: extensionScalar(domainRaw),
		}
		if route.Method == "" || route.Path == "" || route.Access == "" {
			continue
		}
		routes = append(routes, route)
	}
	if len(routes) == 0 {
		return nil, errors.New("route extraction produced no routes")
	}
	return routes, nil
}

func renderExtensionTemplate(template string, values, secrets, probeValues map[string]string, runtime bool) string {
	return regexp.MustCompile(`\{([^{}]+)\}`).ReplaceAllStringFunc(template, func(reference string) string {
		name := strings.TrimSuffix(strings.TrimPrefix(reference, "{"), "}")
		switch {
		case strings.HasPrefix(name, "field:"):
			return values[strings.TrimPrefix(name, "field:")]
		case strings.HasPrefix(name, "secret:"):
			return secrets[strings.TrimPrefix(name, "secret:")]
		case strings.HasPrefix(name, "probeMap:"):
			return renderExtensionProbeMap(name, probeValues)
		case name == "gatewayBase" || name == "standIn":
			if runtime {
				return reference
			}
		}
		return reference
	})
}

func renderExtensionProbeMap(expression string, probeValues map[string]string) string {
	parts := strings.Split(strings.TrimPrefix(expression, "probeMap:"), "|")
	probeID, name, ok := ExtensionProbeValueReference("probe:" + parts[0])
	if !ok || len(parts) < 2 {
		return ""
	}
	value := probeValues[probeID+"/"+name]
	fallback := ""
	for _, rule := range parts[1:] {
		match, replacement, ok := strings.Cut(rule, "=")
		if !ok {
			continue
		}
		if match == value {
			return replacement
		}
		if match == "*" {
			fallback = replacement
		}
	}
	return fallback
}

func (s *Service) sealExtensionSecrets(ctx context.Context, appID string, values map[string]string) error {
	if len(values) == 0 {
		return nil
	}
	if s.secrets == nil {
		return ErrSecretsNotConfigured
	}
	payload, err := json.Marshal(extensionSecretPayload{Version: extensionSecretVersion, Values: values})
	if err != nil {
		return err
	}
	return s.secrets.PutSecret(ctx, ExtensionSecretID(appID), payload, ExtensionSecretID(appID))
}

func (s *Service) loadExtensionSecrets(ctx context.Context, appID string) (map[string]string, error) {
	if s.secrets == nil {
		return nil, ErrSecretsNotConfigured
	}
	raw, err := s.secrets.GetSecret(ctx, ExtensionSecretID(appID))
	if errors.Is(err, store.ErrNotFound) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var payload extensionSecretPayload
	if json.Unmarshal(raw, &payload) != nil || payload.Version != extensionSecretVersion {
		return nil, errors.New("the sealed connector fields are unreadable")
	}
	return nonNilMap(payload.Values), nil
}

func decodeExtensionData(app store.ExternalProviderApp) (store.ExtensionInstanceData, error) {
	data := store.ExtensionInstanceData{}
	if strings.TrimSpace(app.ExtensionData) == "" {
		return data, errors.New("the connector instance has no validated metadata")
	}
	if err := json.Unmarshal([]byte(app.ExtensionData), &data); err != nil {
		return data, fmt.Errorf("decode connector instance metadata: %w", err)
	}
	if data.Descriptor.ServerHeld == nil {
		return data, errors.New("the connector instance metadata has no serverHeld descriptor")
	}
	data.Values = nonNilMap(data.Values)
	data.ProbeValues = nonNilMap(data.ProbeValues)
	if data.FieldOptions == nil {
		data.FieldOptions = store.ConnectorServerHeldFieldOptions{}
	}
	if data.Network == "" {
		data.Network = ExtensionNetworkServer
	}
	return data, nil
}

func encodeExtensionData(data store.ExtensionInstanceData) (string, error) {
	raw, err := json.Marshal(data)
	return string(raw), err
}

func extensionInputSecrets(input store.ConnectorServerHeldInstanceInput, descriptor store.ConnectorDescriptor, existing map[string]string) map[string]string {
	secrets := nonNilMap(existing)
	for _, field := range descriptor.ServerHeld.Fields {
		if field.Type == "secret" {
			if value := strings.TrimSpace(input.Fields[field.ID]); value != "" {
				secrets[field.ID] = value
			}
		}
	}
	return secrets
}

func extensionInstance(app store.ExternalProviderApp, account store.ExternalAccount, data store.ExtensionInstanceData, secrets map[string]string) store.ConnectorServerHeldInstance {
	access := data.Access
	if data.Descriptor.ServerHeld != nil && access == "" {
		access = ExtensionAccessLevel(data.Descriptor.ServerHeld.Access, data.ProbeValues)
	}
	return store.ConnectorServerHeldInstance{
		ID:               app.ID,
		AccountID:        account.ID,
		Kind:             app.Provider,
		Label:            app.Label,
		Network:          data.Network,
		ProbeDeviceID:    data.ProbeDeviceID,
		AvailableDevices: data.AvailableDevices,
		Status:           string(account.Status),
		StatusDetail:     account.StatusDetail,
		Access:           store.ConnectorServerHeldInstanceAccess(access),
		Version:          data.Version,
		RouteCount:       len(data.Routes),
		Values:           jsonempty.Map[string](nonNilMap(data.Values)),
		SecretFields:     jsonempty.List[string](jsonemptyList(secretFieldIDs(data.Descriptor.ServerHeld.Fields, secrets))),
		FieldOptions:     jsonempty.Map[store.ConnectorOptionList](data.FieldOptions),
		ProbeValues:      jsonempty.Map[string](nonNilMap(data.ProbeValues)),
		CreatedAt:        app.CreatedAt,
		UpdatedAt:        app.UpdatedAt,
	}
}

func nonNilMap(value map[string]string) map[string]string {
	if value == nil {
		return map[string]string{}
	}
	return value
}

func jsonemptyList(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func (s *Service) extensionAccount(ctx context.Context, ownerUserID, provider, appID string) (store.ExternalAccount, error) {
	accounts, err := s.store.ListExternalAccounts(ctx, ownerUserID)
	if err != nil {
		return store.ExternalAccount{}, err
	}
	for _, account := range accounts {
		if account.OwnerUserID == ownerUserID && account.Provider == provider && account.AppID == appID {
			return account, nil
		}
	}
	return store.ExternalAccount{}, store.ErrExternalAccountNotFound
}

func (s *Service) ListExtensionInstances(ctx context.Context, ownerUserID, kind string) ([]store.ConnectorServerHeldInstance, error) {
	apps, err := s.store.ListExternalProviderApps(ctx, ownerUserID)
	if err != nil {
		return nil, err
	}
	var instances []store.ConnectorServerHeldInstance
	for _, app := range apps {
		if app.OwnerUserID != ownerUserID || app.Provider != kind || app.CreatedVia != "extension" {
			continue
		}
		data, err := decodeExtensionData(app)
		if err != nil {
			continue
		}
		account, err := s.extensionAccount(ctx, ownerUserID, kind, app.ID)
		if err != nil {
			continue
		}
		secrets, _ := s.loadExtensionSecrets(ctx, app.ID)
		instances = append(instances, extensionInstance(app, account, data, secrets))
	}
	return instances, nil
}

func (s *Service) CreateExtensionInstance(ctx context.Context, ownerUserID string, descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput) (store.ConnectorServerHeldInstance, error) {
	if !s.SecretsConfigured() {
		return store.ConnectorServerHeldInstance{}, ErrSecretsNotConfigured
	}
	st, err := s.extensionStore()
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	if descriptor.ServerHeld == nil {
		return store.ConnectorServerHeldInstance{}, fmt.Errorf("%w: connector has no serverHeld declaration", ErrInvalidExtensionInstance)
	}
	if descriptor.ServerHeld.Instances == "one" {
		existing, err := s.ListExtensionInstances(ctx, ownerUserID, descriptor.Kind)
		if err != nil {
			return store.ConnectorServerHeldInstance{}, err
		}
		if len(existing) > 0 {
			return store.ConnectorServerHeldInstance{}, fmt.Errorf("%w: this connector allows one instance", ErrInvalidExtensionInstance)
		}
	}
	input = normalizeExtensionInput(input)
	network, err := extensionNetwork(descriptor, input)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	values, _, err := extensionFieldValues(descriptor, input, nil, false)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	secrets := extensionInputSecrets(input, descriptor, nil)
	probe, routes, err := s.probeExtension(ctx, descriptor, network, input.DeviceID, values, secrets)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	label := input.Label
	if label == "" {
		label = descriptor.Label
		if base := probe.Values[descriptor.ServerHeld.Upstream.BaseField]; base != "" {
			if parsed, err := url.Parse(base); err == nil && parsed.Hostname() != "" {
				label += " " + parsed.Hostname()
			}
		}
	}
	data := store.ExtensionInstanceData{
		Descriptor: descriptor, Values: probe.Values, ProbeValues: probe.ProbeValues,
		FieldOptions: map[string][]store.ConnectorOption(probe.FieldOptions), Routes: routes,
		Access: ExtensionAccessLevel(descriptor.ServerHeld.Access, probe.ProbeValues), Version: probe.Version, StatusDetail: "ok",
		Network: network, ProbeDeviceID: probe.ProbeDeviceID, AvailableDevices: probe.AvailableDevices,
	}
	rawData, err := encodeExtensionData(data)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	app, err := s.store.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		Provider: descriptor.Kind, OwnerUserID: ownerUserID, Visibility: store.ExternalAppPersonal,
		Label: label, BaseURL: data.Values[descriptor.ServerHeld.Upstream.BaseField], CreatedVia: "extension", ExtensionData: rawData,
	})
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	cleanup := func(cause error) error {
		_ = s.store.DeleteExternalProviderApp(ctx, app.ID)
		if s.secrets != nil {
			_ = s.secrets.DeleteSecret(ctx, ExtensionSecretID(app.ID))
		}
		return cause
	}
	if err := s.sealExtensionSecrets(ctx, app.ID, secrets); err != nil {
		return store.ConnectorServerHeldInstance{}, cleanup(fmt.Errorf("seal connector fields: %w", err))
	}
	account, err := s.store.SaveExternalAccount(ctx, store.ExternalAccount{
		ID: "xacc_" + uuid.NewString(), AppID: app.ID, Provider: descriptor.Kind, OwnerUserID: ownerUserID,
		Label: label, Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, KeepAlive: false,
	})
	if err != nil {
		return store.ConnectorServerHeldInstance{}, cleanup(err)
	}
	rawData, _ = encodeExtensionData(data)
	if _, err := st.SaveExternalProviderAppExtensionData(ctx, app.ID, rawData); err != nil {
		_ = s.store.DeleteExternalAccount(ctx, account.ID)
		return store.ConnectorServerHeldInstance{}, cleanup(err)
	}
	app, _ = s.store.GetExternalProviderApp(ctx, app.ID)
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "extension_instance_added", ActorID: ownerUserID, Detail: descriptor.Kind})
	return extensionInstance(app, account, data, secrets), nil
}

func (s *Service) CheckExtensionInstance(ctx context.Context, ownerUserID, kind, appID string, current *store.ConnectorDescriptor) (store.ConnectorServerHeldInstance, error) {
	st, err := s.extensionStore()
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	app, err := s.store.GetExternalProviderApp(ctx, appID)
	if err != nil || app.OwnerUserID != ownerUserID || app.Provider != kind || app.CreatedVia != "extension" {
		return store.ConnectorServerHeldInstance{}, store.ErrExternalAppNotFound
	}
	data, err := decodeExtensionData(app)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	descriptor := data.Descriptor
	if current != nil {
		descriptor = *current
	}
	secrets, err := s.loadExtensionSecrets(ctx, app.ID)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	input := store.ConnectorServerHeldInstanceInput{
		Label: app.Label, Fields: data.Values, Network: data.Network, DeviceID: data.ProbeDeviceID,
	}
	network, err := extensionNetwork(descriptor, input)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	values, _, err := extensionFieldValues(descriptor, input, secrets, false)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	probe, routes, err := s.probeExtension(ctx, descriptor, network, input.DeviceID, values, secrets)
	account, accountErr := s.extensionAccount(ctx, ownerUserID, kind, app.ID)
	if err != nil {
		data.StatusDetail = extensionProbeDetail(err)
		rawData, _ := encodeExtensionData(data)
		_, _ = st.SaveExternalProviderAppExtensionData(ctx, app.ID, rawData)
		if accountErr == nil {
			account.Status, account.StatusDetail = store.ExternalAccountNeedsReauth, extensionProbeClass(err)
			_, _ = s.store.SaveExternalAccount(ctx, account)
		}
		return store.ConnectorServerHeldInstance{}, err
	}
	data.Descriptor, data.Values, data.ProbeValues = descriptor, probe.Values, probe.ProbeValues
	data.FieldOptions = map[string][]store.ConnectorOption(probe.FieldOptions)
	data.Access = ExtensionAccessLevel(descriptor.ServerHeld.Access, probe.ProbeValues)
	data.Version, data.StatusDetail, data.Routes = probe.Version, "ok", routes
	data.Network, data.ProbeDeviceID, data.AvailableDevices = network, probe.ProbeDeviceID, probe.AvailableDevices
	rawData, _ := encodeExtensionData(data)
	app, err = st.SaveExternalProviderAppExtensionData(ctx, app.ID, rawData)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	if accountErr == nil {
		account.Status, account.StatusDetail = store.ExternalAccountReady, ""
		account, accountErr = s.store.SaveExternalAccount(ctx, account)
	}
	if accountErr != nil {
		return store.ConnectorServerHeldInstance{}, accountErr
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "extension_instance_checked", ActorID: ownerUserID, Detail: descriptor.Kind})
	return extensionInstance(app, account, data, secrets), nil
}

func (s *Service) ReplaceExtensionInstance(ctx context.Context, ownerUserID, kind, appID string, descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput) (store.ConnectorServerHeldInstance, error) {
	st, err := s.extensionStore()
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	app, err := s.store.GetExternalProviderApp(ctx, appID)
	if err != nil || app.OwnerUserID != ownerUserID || app.Provider != kind || app.CreatedVia != "extension" {
		return store.ConnectorServerHeldInstance{}, store.ErrExternalAppNotFound
	}
	if _, err := decodeExtensionData(app); err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	existingSecrets, err := s.loadExtensionSecrets(ctx, app.ID)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	input = normalizeExtensionInput(input)
	network, err := extensionNetwork(descriptor, input)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	values, _, err := extensionFieldValues(descriptor, input, existingSecrets, false)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	secrets := extensionInputSecrets(input, descriptor, existingSecrets)
	probe, routes, err := s.probeExtension(ctx, descriptor, network, input.DeviceID, values, secrets)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	data := store.ExtensionInstanceData{
		Descriptor: descriptor, Values: probe.Values, ProbeValues: probe.ProbeValues,
		FieldOptions: map[string][]store.ConnectorOption(probe.FieldOptions), Routes: routes,
		Access: ExtensionAccessLevel(descriptor.ServerHeld.Access, probe.ProbeValues), Version: probe.Version, StatusDetail: "ok",
		Network: network, ProbeDeviceID: probe.ProbeDeviceID, AvailableDevices: probe.AvailableDevices,
	}
	if err := s.sealExtensionSecrets(ctx, app.ID, secrets); err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	label := strings.TrimSpace(input.Label)
	if label == "" {
		label = app.Label
	}
	rawData, err := encodeExtensionData(data)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	app, err = st.UpdateExternalProviderAppExtension(ctx, app.ID, label, app.ClientID, probe.Values[descriptor.ServerHeld.Upstream.BaseField], rawData)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	account, err := s.extensionAccount(ctx, ownerUserID, kind, app.ID)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	account.Label, account.Status, account.StatusDetail = label, store.ExternalAccountReady, ""
	account, err = s.store.SaveExternalAccount(ctx, account)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "extension_instance_replaced", ActorID: ownerUserID, Detail: kind})
	return extensionInstance(app, account, data, secrets), nil
}

func (s *Service) RevokeExtensionInstance(ctx context.Context, ownerUserID, kind, appID, actorID string) (store.ConnectorServerHeldInstance, error) {
	st, err := s.extensionStore()
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	app, err := s.store.GetExternalProviderApp(ctx, appID)
	if err != nil || app.OwnerUserID != ownerUserID || app.Provider != kind || app.CreatedVia != "extension" {
		return store.ConnectorServerHeldInstance{}, store.ErrExternalAppNotFound
	}
	data, err := decodeExtensionData(app)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	if s.secrets != nil {
		if err := s.secrets.DeleteSecret(ctx, ExtensionSecretID(app.ID)); err != nil && !errors.Is(err, store.ErrNotFound) {
			return store.ConnectorServerHeldInstance{}, err
		}
	}
	data.StatusDetail = "revoked"
	rawData, _ := encodeExtensionData(data)
	app, err = st.SaveExternalProviderAppExtensionData(ctx, app.ID, rawData)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	account, err := s.extensionAccount(ctx, ownerUserID, kind, app.ID)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	account.Status, account.StatusDetail = store.ExternalAccountRevoked, "credential_revoked"
	account, err = s.store.SaveExternalAccount(ctx, account)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	s.event(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "extension_instance_revoked", ActorID: actorID})
	return extensionInstance(app, account, data, nil), nil
}

func extensionProbeClass(err error) string {
	var probeErr *ExtensionProbeError
	if errors.As(err, &probeErr) {
		return probeErr.Class
	}
	return "unreachable"
}

func extensionProbeDetail(err error) string {
	var probeErr *ExtensionProbeError
	if errors.As(err, &probeErr) {
		return probeErr.Class + ": " + probeErr.Message
	}
	return "unreachable: " + err.Error()
}

func (s *Service) ExtensionSessionEnvironment(ctx context.Context, app store.ExternalProviderApp, data store.ExtensionInstanceData) (map[string]string, error) {
	secrets, err := s.loadExtensionSecrets(ctx, app.ID)
	if err != nil {
		return nil, err
	}
	serverHeld := data.Descriptor.ServerHeld
	if serverHeld == nil {
		return nil, errors.New("connector extension has no serverHeld declaration")
	}
	env := map[string]string{}
	for name, template := range serverHeld.Session.Env {
		value := renderExtensionTemplate(template, data.Values, secrets, data.ProbeValues, true)
		reference := strings.TrimSpace(template)
		if strings.HasPrefix(reference, "{field:") && strings.HasSuffix(reference, "}") {
			fieldID := strings.TrimSuffix(strings.TrimPrefix(reference, "{field:"), "}")
			if data.Values[fieldID] == "" {
				continue
			}
		}
		env[name] = value
	}
	return env, nil
}

func (s *Service) ExtensionData(ctx context.Context, app store.ExternalProviderApp) (store.ExtensionInstanceData, error) {
	if app.CreatedVia != "extension" {
		return store.ExtensionInstanceData{}, errors.New("not a connector extension instance")
	}
	data, err := decodeExtensionData(app)
	if err != nil {
		return store.ExtensionInstanceData{}, err
	}
	_ = ctx
	return data, nil
}

func (s *Service) DoExtensionRequest(ctx context.Context, app store.ExternalProviderApp, deviceID, method, path string, query url.Values, headers http.Header, body io.Reader) (*http.Response, error) {
	if err := s.Integrations.Err(); err != nil {
		return nil, err
	}
	data, err := s.ExtensionData(ctx, app)
	if err != nil {
		return nil, err
	}
	client := s.extensionClient()
	network := data.Network
	if network == "" {
		network = ExtensionNetworkServer
	}
	endpoint, err := client.endpointForNetwork(ctx, extensionBaseURL(data.Descriptor.ServerHeld, data.Values[data.Descriptor.ServerHeld.Upstream.BaseField]), network, deviceID)
	if err != nil {
		return nil, err
	}
	target := endpoint.URL(path)
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var rawBody []byte
	if body != nil {
		rawBody, err = io.ReadAll(body)
		if err != nil {
			return nil, err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(rawBody))
	if err != nil {
		return nil, err
	}
	secrets, err := s.loadExtensionSecrets(ctx, app.ID)
	if err != nil {
		return nil, err
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	for _, name := range []string{"Authorization", "Cookie", "Host", "X-Foundry-Device-Credential", "X-Foundry-Forwarder-Host"} {
		request.Header.Del(name)
	}
	for name := range data.Descriptor.ServerHeld.Upstream.Headers {
		request.Header.Del(name)
	}
	for name, template := range data.Descriptor.ServerHeld.Upstream.Headers {
		if value := renderExtensionTemplate(template, data.Values, secrets, nil, false); value != "" {
			request.Header.Set(name, value)
		}
	}
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json, application/*+json")
	}
	request.Header.Set("User-Agent", "Foundry-Connector/1.0")
	timeout := extensionDefaultTimeout
	if seconds := data.Descriptor.ServerHeld.Upstream.TimeoutSeconds; seconds > 0 {
		timeout = time.Duration(seconds) * time.Second
	}
	if endpoint.deviceID != "" {
		return s.doDeviceExtensionRequest(ctx, endpoint.deviceID, request)
	}
	return endpoint.clientFor(client.client, client.allowInsecure, timeout).Do(request)
}

func NewExtensionTestClient(client *http.Client) *ExtensionClient {
	return &ExtensionClient{client: client, allowInsecure: true}
}

func extensionBaseURL(serverHeld *store.ConnectorServerHeldSpec, raw string) string {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	prefix := strings.TrimRight(strings.TrimSpace(serverHeld.Upstream.PathPrefix), "/")
	if prefix != "" && strings.HasSuffix(base, prefix) {
		base = strings.TrimSuffix(base, prefix)
	}
	return base
}
