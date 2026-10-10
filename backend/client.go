package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	http "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const maxEventBytes = 2 << 20

// Upstream errors deliberately exclude response bodies, request URLs and cookies.
type apiError struct {
	Status     int    `json:"status"`
	Message    string `json:"message"`
	RetryAfter string `json:"retryAfter,omitempty"`
}

func (e *apiError) Error() string { return e.Message }

type credentials struct {
	Key string `json:"key"`
}
type client struct {
	http          tlsclient.HttpClient
	base, cookie  string
	orgLock       chan struct{}
	org           string
	guard         *accountGuard
	conversations map[string]*conversation
	modelIDs      []string
	modelsAt      time.Time
}

func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("system random source unavailable")
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func cookieValue(cookie, name string) string {
	for _, p := range strings.Split(cookie, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
		if ok && k == name {
			return v
		}
	}
	return ""
}

func newClient(base, proxy string, auth credentials) (*client, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, &apiError{Status: 400, Message: "Invalid upstream origin"}
	}
	// HTTP is permitted only for local integration-test servers.
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return nil, &apiError{Status: 400, Message: "Upstream requires HTTPS"}
	}
	key := strings.TrimSpace(auth.Key)
	if key == "" || strings.ContainsAny(key, "\r\n") {
		return nil, &apiError{Status: 401, Message: "Provide a Claude sessionKey or full Cookie"}
	}
	cookie := key
	if !strings.Contains(key, "=") {
		cookie = "sessionKey=" + key
	}
	if cookieValue(cookie, "sessionKey") == "" {
		return nil, &apiError{Status: 401, Message: "Cookie has no sessionKey"}
	}
	if cookieValue(cookie, "anthropic-device-id") == "" {
		cookie += "; anthropic-device-id=" + uuid()
	}
	if cookieValue(cookie, "sessionKeyLC") == "" {
		cookie += fmt.Sprintf("; sessionKeyLC=%d", time.Now().UnixMilli())
	}
	if cookieValue(cookie, "activitySessionId") == "" {
		cookie += "; activitySessionId=" + uuid()
	}
	opts := []tlsclient.HttpClientOption{
		tlsclient.WithTimeoutSeconds(300), tlsclient.WithClientProfile(profiles.Chrome_152),
		tlsclient.WithCookieJar(tlsclient.NewCookieJar()), tlsclient.WithNotFollowRedirects(),
	}
	if proxy != "" && proxy != "direct" {
		p, e := url.Parse(proxy)
		if e != nil || p.Host == "" || (p.Scheme != "http" && p.Scheme != "https" && p.Scheme != "socks5" && p.Scheme != "socks5h") {
			return nil, &apiError{Status: 400, Message: "Invalid proxy URL"}
		}
		opts = append(opts, tlsclient.WithProxyUrl(proxy))
	}
	h, e := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), opts...)
	if e != nil {
		return nil, &apiError{Status: 502, Message: "Could not initialize browser transport"}
	}
	// Organization cookies are hints, not validated identifiers: query the account instead.
	return &client{http: h, base: strings.TrimRight(base, "/"), cookie: cookie, orgLock: make(chan struct{}, 1), guard: &accountGuard{slot: make(chan struct{}, 1)}, conversations: make(map[string]*conversation)}, nil
}

func (c *client) request(ctx context.Context, method, path string, body any, referer string) (*http.Response, error) {
	if err := c.guard.restriction(); err != nil {
		return nil, err
	}
	var r io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		r = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, c.base+path, r)
	if e != nil {
		return nil, &apiError{Status: 400, Message: "Invalid upstream request"}
	}
	req.Header.Set("Cookie", c.cookie)
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36")
	req.Header.Set("sec-ch-ua", `"Google Chrome";v="152", "Not.A/Brand";v="8", "Chromium";v="152"`)
	req.Header.Set("sec-ch-ua-mobile", "?0")
	req.Header.Set("sec-ch-ua-platform", `"Windows"`)
	req.Header.Set("sec-fetch-dest", "empty")
	req.Header.Set("sec-fetch-mode", "cors")
	req.Header.Set("sec-fetch-site", "same-origin")
	req.Header.Set("Origin", c.base)
	req.Header.Set("Referer", c.base+referer)
	req.Header.Set("anthropic-client-platform", "web_claude_ai")
	req.Header.Set("anthropic-device-id", cookieValue(c.cookie, "anthropic-device-id"))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, e := c.http.Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &apiError{Status: 502, Message: "Claude web request failed; check connection and proxy"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		// The status is sufficient. Do not wait for an error page to finish
		// streaming before protecting the account or reporting the restriction.
		status := resp.StatusCode
		if status < 400 {
			status = 502
		}
		retry := c.guard.observe(status, resp.Header.Get("Retry-After"))
		return nil, &apiError{Status: status, Message: fmt.Sprintf("Claude web returned HTTP %d", resp.StatusCode), RetryAfter: retry}
	}
	return resp, nil
}

func (c *client) organization(ctx context.Context) (string, error) {
	// A cancelled request must not wait behind another request's
	// network lookup. The channel still serializes the in-memory organization.
	if err := ctx.Err(); err != nil {
		return "", err
	}
	select {
	case c.orgLock <- struct{}{}:
		defer func() { <-c.orgLock }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if c.org != "" {
		return c.org, nil
	}
	resp, e := c.request(ctx, "GET", "/api/organizations", nil, "/new")
	if e != nil {
		return "", e
	}
	defer resp.Body.Close()
	var orgs []struct {
		UUID string `json:"uuid"`
	}
	if e = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&orgs); e != nil || len(orgs) == 0 {
		return "", &apiError{Status: 502, Message: "Claude returned no usable organization"}
	}
	// Match the browser's active organization only after confirming membership.
	// A stale or foreign lastActiveOrg must never become an authenticated path.
	hint := cookieValue(c.cookie, "lastActiveOrg")
	for _, org := range orgs {
		if org.UUID == "" {
			continue
		}
		if c.org == "" {
			c.org = org.UUID
		}
		if org.UUID == hint {
			c.org = org.UUID
			break
		}
	}
	if c.org == "" {
		return "", &apiError{Status: 502, Message: "Claude returned no usable organization"}
	}
	return c.org, nil
}

func (c *client) models(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	release, e := c.guard.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer release()
	if len(c.modelIDs) > 0 && time.Since(c.modelsAt) < time.Minute {
		return append([]string(nil), c.modelIDs...), nil
	}
	org, e := c.organization(ctx)
	if e != nil {
		return nil, e
	}
	path := "/edge-api/bootstrap/" + url.PathEscape(org) + "/app_start?statsig_hashing_algorithm=djb2&growthbook_format=sdk&cache_bust=1&include_system_prompts=false"
	resp, e := c.request(ctx, "GET", path, nil, "/new")
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	var data struct {
		Available struct {
			Models []struct {
				ID string `json:"model_id"`
			} `json:"models"`
		} `json:"claude_ai_available_models"`
	}
	if e = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&data); e != nil {
		return nil, &apiError{Status: 502, Message: "Invalid Claude model catalog"}
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, m := range data.Available.Models {
		id := strings.TrimSpace(m.ID)
		if id != "" && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	if len(ids) == 0 {
		return nil, &apiError{Status: 502, Message: "Claude model catalog is empty"}
	}
	c.modelIDs = append([]string(nil), ids...)
	c.modelsAt = time.Now()
	return ids, nil
}

func (c *client) create(ctx context.Context) (string, error) {
	org, e := c.organization(ctx)
	if e != nil {
		return "", e
	}
	resp, e := c.request(ctx, "POST", "/api/organizations/"+url.PathEscape(org)+"/chat_conversations", map[string]any{"name": "", "organization_uuid": org}, "/new")
	if e != nil {
		return "", e
	}
	defer resp.Body.Close()
	var conv struct {
		UUID string `json:"uuid"`
	}
	if e = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&conv); e != nil || conv.UUID == "" {
		return "", &apiError{Status: 502, Message: "Invalid Claude conversation response"}
	}
	return conv.UUID, nil
}

func (c *client) delete(conv string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c.deleteWithContext(ctx, conv)
}

func (c *client) deleteWithContext(ctx context.Context, conv string) {
	if ctx.Err() != nil || c.guard.restriction() != nil {
		return
	}
	org, e := c.organization(ctx)
	if e != nil {
		return
	}
	resp, e := c.request(ctx, "DELETE", "/api/organizations/"+url.PathEscape(org)+"/chat_conversations/"+url.PathEscape(conv), nil, "/chat/"+conv)
	if e == nil {
		resp.Body.Close()
	}
}

type completion struct {
	ConversationID string   `json:"conversation_id"`
	History        []string `json:"history"`
	ContextKey     string   `json:"context_key"`
	RequestKey     string   `json:"request_key"`
	TurnKey        string   `json:"turn_key"`
	Model          string   `json:"model"`
	Prompt         string   `json:"prompt"`
	Effort         string   `json:"effort"`
	Thinking       string   `json:"thinking"`
	Locale         string   `json:"locale"`
	Timezone       string   `json:"timezone"`
}

func (c *client) complete(ctx context.Context, p completion, head func(), emit func(json.RawMessage) error) error {
	if p.Model == "" || p.Prompt == "" {
		return &apiError{Status: 400, Message: "Model and prompt are required"}
	}
	if len(p.ConversationID) > 256 || strings.ContainsAny(p.ConversationID, "\r\n\x00") || len(p.History) > 8192 || len(p.Model) > 256 || len(p.ContextKey) > 256 || len(p.RequestKey) > 256 || len(p.TurnKey) > 256 {
		return &apiError{Status: 400, Message: "Invalid conversation_id"}
	}
	release, e := c.guard.begin(ctx)
	if e != nil {
		return e
	}
	defer release()
	var state *conversation
	conv := ""
	if p.ConversationID != "" {
		state, e = c.conversation(ctx, p)
		if e != nil {
			return e
		}
		conv = state.uuid
		if p.RequestKey == "" {
			hash := sha256.Sum256([]byte(p.Prompt))
			p.RequestKey = hex.EncodeToString(hash[:])
		}
		if state.requestKey == p.RequestKey {
			return &apiError{Status: 409, Message: "This conversation turn already completed; send new history or use a new conversation_id"}
		}
	} else {
		conv, e = c.create(ctx)
		if e != nil {
			return e
		}
		defer c.delete(conv)
	}
	org, e := c.organization(ctx)
	if e != nil {
		return e
	}
	parent, assistant := uuid(), uuid()
	if state != nil && state.parent != "" {
		parent = state.parent
	}
	body := map[string]any{
		"prompt": p.Prompt, "model": p.Model, "effort": p.Effort, "thinking_mode": p.Thinking,
		"timezone": p.Timezone, "locale": p.Locale, "parent_message_uuid": parent,
		"turn_message_uuids": map[string]string{"human_message_uuid": uuid(), "assistant_message_uuid": assistant},
		"tools":              []any{}, "attachments": []any{}, "files": []any{}, "sync_sources": []any{}, "rendering_mode": "messages",
		"create_conversation_params": map[string]any{"name": "", "model": p.Model, "include_conversation_preferences": true, "is_temporary": true, "tool_search_mode": "auto"},
	}
	resp, e := c.request(ctx, "POST", "/api/organizations/"+url.PathEscape(org)+"/chat_conversations/"+url.PathEscape(conv)+"/completion", body, "/chat/"+conv)
	if e != nil {
		if state != nil {
			c.forgetConversation(p.ConversationID, state)
		}
		return e
	}
	defer resp.Body.Close()
	head()
	e = readSSE(ctx, resp.Body, func(raw json.RawMessage) error {
		var event struct {
			Type  string `json:"type"`
			Error struct {
				Type      string `json:"type"`
				ErrorType string `json:"error_type"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &event)
		if event.Type == "error" {
			status := 502
			typ := event.Error.Type
			if typ == "" {
				typ = event.Error.ErrorType
			}
			switch typ {
			case "rate_limit_error":
				status = 429
			case "authentication_error":
				status = 401
			case "permission_error":
				status = 403
			}
			return &apiError{Status: status, Message: "Claude stream reported an upstream error", RetryAfter: c.guard.observe(status, "")}
		}
		return emit(raw)
	})
	if state != nil {
		if e != nil {
			c.forgetConversation(p.ConversationID, state)
		} else {
			state.parent = assistant
			state.used = time.Now()
			state.contextKey = p.ContextKey
			state.historyLength = len(p.History)
			state.historyHash = historyHash(p.History)
			state.requestKey = p.RequestKey
			state.turnKey = p.TurnKey
		}
	}
	return e
}

// A successful stream must have message_stop, including when the last frame has no blank line.
func readSSE(ctx context.Context, r io.Reader, emit func(json.RawMessage) error) error {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 64<<10), maxEventBytes)
	var data []string
	dataBytes := 0
	event := ""
	stopped := false
	flush := func() error {
		if len(data) == 0 {
			event = ""
			return nil
		}
		raw := []byte(strings.Join(data, "\n"))
		data = nil
		dataBytes = 0
		var evt map[string]json.RawMessage
		if json.Unmarshal(raw, &evt) != nil || evt == nil {
			return &apiError{Status: 502, Message: "Invalid Claude stream event"}
		}
		if _, ok := evt["type"]; !ok {
			evt["type"], _ = json.Marshal(event)
			var encoded bytes.Buffer
			enc := json.NewEncoder(&encoded)
			enc.SetEscapeHTML(false)
			if err := enc.Encode(evt); err != nil {
				return &apiError{Status: 502, Message: "Invalid Claude stream event"}
			}
			raw = encoded.Bytes()
		}
		event = ""
		var typ string
		_ = json.Unmarshal(evt["type"], &typ)
		if typ == "message_stop" {
			stopped = true
		}
		return emit(raw)
	}
	for scan.Scan() {
		if e := ctx.Err(); e != nil {
			return e
		}
		line := scan.Text()
		if line == "" {
			if e := flush(); e != nil {
				return e
			}
			if stopped {
				return nil
			}
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			dataBytes += len(value) + 1
			if dataBytes > maxEventBytes {
				return &apiError{Status: 502, Message: "Claude stream event exceeds size limit"}
			}
			data = append(data, value)
		}
	}
	if e := scan.Err(); e != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &apiError{Status: 502, Message: "Claude stream read failed"}
	}
	if e := flush(); e != nil {
		return e
	}
	if !stopped {
		return &apiError{Status: 502, Message: "Claude stream ended before message_stop"}
	}
	return nil
}

func publicError(err error) *apiError {
	var e *apiError
	if errors.As(err, &e) {
		return e
	}
	if errors.Is(err, context.Canceled) {
		return &apiError{Status: 499, Message: "Request cancelled"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &apiError{Status: 504, Message: "Claude web request timed out"}
	}
	return &apiError{Status: 502, Message: "Claude web backend failed"}
}
