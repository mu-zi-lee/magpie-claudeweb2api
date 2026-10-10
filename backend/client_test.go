package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSSECompletionAndTruncation(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		ok         bool
	}{
		{"multiline-final-frame", "event: content_block_delta\ndata: {\"delta\":\ndata: {\"type\":\"text_delta\",\"text\":\"你好\"}}\n\nevent: message_stop\ndata: {}", true},
		{"truncated", "event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n", false},
		{"invalid-json", "data: {broken}\n\n", false},
		{"null-event", "data: null\n\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var events []json.RawMessage
			err := readSSE(context.Background(), strings.NewReader(tc.body), func(v json.RawMessage) error { events = append(events, v); return nil })
			if (err == nil) != tc.ok {
				t.Fatalf("err=%v", err)
			}
			if tc.ok && len(events) != 2 {
				t.Fatalf("got %d events", len(events))
			}
		})
	}
}

func TestOrganizationCookieMustBelongToAccount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `[{"uuid":"first"},{"uuid":"active"}]`)
	}))
	defer server.Close()
	for _, tc := range []struct{ hint, want string }{{"active", "active"}, {"foreign", "first"}, {"", "first"}} {
		c, err := newClient(server.URL, "", credentials{Key: "sessionKey=test; lastActiveOrg=" + tc.hint})
		if err != nil {
			t.Fatal(err)
		}
		defer c.http.CloseIdleConnections()
		org, err := c.organization(context.Background())
		if err != nil || org != tc.want {
			t.Fatalf("hint=%q org=%q err=%v", tc.hint, org, err)
		}
	}
}

func TestCancelledOrganizationWaitDoesNotBlock(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	c, err := newClient(server.URL, "", credentials{Key: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.http.CloseIdleConnections()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan error, 1)
	go func() { _, err := c.organization(ctx); first <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("organization request never started")
	}
	secondCtx, stop := context.WithCancel(context.Background())
	stop()
	second := make(chan error, 1)
	go func() { _, err := c.models(secondCtx); second <- err }()
	select {
	case err := <-second:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected cancellation, got %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		cancel()
		<-first
		<-second
		t.Fatal("cancelled model discovery waited for another request's organization lookup")
	}
	cancel()
	<-first
}

func TestWireKeepsLargeMarkupWithinFrameBudget(t *testing.T) {
	// A valid 1.8 MiB webpage delta must not expand beyond the bridge's 4 MiB
	// limit just because it contains HTML characters.
	content := strings.Repeat("<>&", 600_000)
	data, err := json.Marshal(map[string]string{"text": content})
	if err != nil {
		t.Fatal(err)
	}
	// The upstream SSE JSON contains literal markup characters.
	data = bytes.ReplaceAll(data, []byte(`\u003c`), []byte("<"))
	data = bytes.ReplaceAll(data, []byte(`\u003e`), []byte(">"))
	data = bytes.ReplaceAll(data, []byte(`\u0026`), []byte("&"))
	var out bytes.Buffer
	w := writer{out: &out}
	if err := w.send(map[string]any{"id": "fixture", "event": "data", "data": json.RawMessage(data)}); err != nil {
		t.Fatal(err)
	}
	if out.Len() > 4<<20 {
		t.Fatal("valid upstream event expanded beyond bridge limit")
	}
	var decoded struct{ Data struct{ Text string } }
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil || decoded.Data.Text != content {
		t.Fatal("markup was altered by the wire protocol", err)
	}
	// SSE event names are also valid without a duplicate JSON type property.
	err = readSSE(context.Background(), strings.NewReader("event: content_block_delta\ndata: "+string(data)+"\n\nevent: message_stop\ndata: {}\n\n"), func(v json.RawMessage) error {
		if len(v) > maxEventBytes {
			return errors.New("adding the event type expanded the valid frame")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPoolKeepsBrowserIdentityAndSeparatesProxies(t *testing.T) {
	p := &clientPool{}
	defer p.close()
	a, release, err := p.acquire("https://claude.ai", "", credentials{Key: "account-one"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	b, release, err := p.acquire("https://claude.ai", "", credentials{Key: "account-one"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	if a != b || cookieValue(a.cookie, "anthropic-device-id") != cookieValue(b.cookie, "anthropic-device-id") {
		t.Fatal("browser identity changed between turns")
	}
	c, release, err := p.acquire("https://claude.ai", "direct", credentials{Key: "account-two"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	if c == a || strings.Contains(c.cookie, "account-one") {
		t.Fatal("account clients were mixed")
	}
}

func TestClientLifecycleIsolationAndErrors(t *testing.T) {
	var deleted atomic.Int32
	var mu sync.Mutex
	cookies := map[string][]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cookies[r.URL.Path] = append(cookies[r.URL.Path], r.Header.Get("Cookie"))
		mu.Unlock()
		if strings.Contains(r.Header.Get("Cookie"), "sessionKey=expired") {
			w.WriteHeader(401)
			fmt.Fprint(w, "secret-cookie-should-not-leak")
			return
		}
		if strings.Contains(r.Header.Get("Cookie"), "sessionKey=limited") {
			w.Header().Set("Retry-After", "12")
			w.WriteHeader(429)
			return
		}
		switch {
		case r.URL.Path == "/api/organizations":
			fmt.Fprint(w, `[{"uuid":"org"}]`)
		case strings.HasPrefix(r.URL.Path, "/edge-api/bootstrap/"):
			fmt.Fprint(w, `{"claude_ai_available_models":{"models":[{"model_id":"new-model"},{"model_id":"new-model"},{"model_id":" "}]}}`)
		case r.Method == "DELETE":
			deleted.Add(1)
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/completion"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if tools, ok := body["tools"].([]any); !ok || len(tools) != 0 {
				t.Error("native web tools were enabled")
			}
			fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		default:
			fmt.Fprint(w, `{"uuid":"conversation"}`)
		}
	}))
	defer server.Close()
	for _, key := range []string{"account-one", "account-two"} {
		c, err := newClient(server.URL, "", credentials{Key: key})
		if err != nil {
			t.Fatal(err)
		}
		ids, err := c.models(context.Background())
		if err != nil || len(ids) != 1 || ids[0] != "new-model" {
			t.Fatalf("models=%v err=%v", ids, err)
		}
		headed := false
		count := 0
		err = c.complete(context.Background(), completion{Model: "new-model", Prompt: "hello", Thinking: "none", Effort: "medium"}, func() { headed = true }, func(json.RawMessage) error { count++; return nil })
		if err != nil || !headed || count != 2 {
			t.Fatalf("complete err=%v head=%v count=%d", err, headed, count)
		}
	}
	if deleted.Load() != 2 {
		t.Fatal("temporary conversations were not deleted")
	}
	mu.Lock()
	orgCookies := append([]string(nil), cookies["/api/organizations"]...)
	mu.Unlock()
	if len(orgCookies) != 2 || !strings.Contains(orgCookies[0], "sessionKey=account-one") || !strings.Contains(orgCookies[1], "sessionKey=account-two") {
		t.Fatal("credentials mixed")
	}
	for _, key := range []string{"expired", "limited"} {
		c, _ := newClient(server.URL, "", credentials{Key: key})
		_, err := c.models(context.Background())
		var api *apiError
		if !errors.As(err, &api) || strings.Contains(err.Error(), "secret-cookie") {
			t.Fatalf("unsafe error: %v", err)
		}
		if key == "expired" && api.Status != 401 {
			t.Fatal(api)
		}
		if key == "limited" && (api.Status != 429 || api.RetryAfter != "12") {
			t.Fatal(api)
		}
	}
}

func TestCredentialsAndOrigins(t *testing.T) {
	for _, key := range []string{"", "sessionKey=", "abc\r\nInjected: true", "other=value"} {
		if _, err := newClient("https://claude.ai", "", credentials{Key: key}); err == nil {
			t.Fatalf("accepted invalid credentials %q", key)
		}
	}
	for _, origin := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path"} {
		if _, err := newClient(origin, "", credentials{Key: "valid"}); err == nil {
			t.Fatalf("accepted origin %s", origin)
		}
	}
}

func TestOwnerEOFStopsRequestsAndCleansConversation(t *testing.T) {
	started := make(chan struct{})
	deleted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/organizations":
			fmt.Fprint(w, `[{"uuid":"org"}]`)
		case r.Method == "DELETE":
			close(deleted)
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/completion"):
			_, _ = io.Copy(io.Discard, r.Body)
			close(started)
			<-r.Context().Done()
		default:
			fmt.Fprint(w, `{"uuid":"conversation"}`)
		}
	}))
	defer server.Close()
	reader, input := io.Pipe()
	var out bytes.Buffer
	done := make(chan struct{})
	go func() { serve(context.Background(), reader, &out); close(done) }()
	cmd := command{ID: "one", Method: "complete", Origin: server.URL, Auth: credentials{Key: "valid"}, Completion: completion{Model: "model", Prompt: "hello"}}
	raw, _ := json.Marshal(cmd)
	_, _ = input.Write(append(raw, '\n'))
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	_ = input.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("backend survived owner EOF")
	}
	select {
	case <-deleted:
	default:
		t.Fatal("cancelled conversation was not cleaned")
	}
	if strings.Contains(out.String(), "sessionKey") {
		t.Fatal("credential leaked into RPC output")
	}
}
