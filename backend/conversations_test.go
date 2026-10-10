package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConversationReuseParentsBranchesAndShutdown(t *testing.T) {
	var creates, deletes atomic.Int32
	var mu sync.Mutex
	var paths []string
	var bodies []struct {
		Parent string `json:"parent_message_uuid"`
		Turns  struct {
			Assistant string `json:"assistant_message_uuid"`
		} `json:"turn_message_uuids"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/organizations":
			fmt.Fprint(w, `[{"uuid":"org"}]`)
		case r.Method == "DELETE":
			deletes.Add(1)
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/completion"):
			var body struct {
				Parent string `json:"parent_message_uuid"`
				Turns  struct {
					Assistant string `json:"assistant_message_uuid"`
				} `json:"turn_message_uuids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			mu.Lock()
			paths = append(paths, r.URL.Path)
			bodies = append(bodies, body)
			mu.Unlock()
			fmt.Fprint(w, "data: {\"type\":\"message_stop\"}\n\n")
		default:
			fmt.Fprintf(w, `{"uuid":"conv-%d"}`, creates.Add(1))
		}
	}))
	defer server.Close()
	c, err := newClient(server.URL, "", credentials{Key: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeClients([]*client{c})
	complete := func(p completion) error {
		return c.complete(context.Background(), p, func() {}, func(json.RawMessage) error { return nil })
	}
	p := completion{ConversationID: "dialogue", Model: "model", Prompt: "first", History: []string{"user-1"}, ContextKey: "system"}
	if err := complete(p); err != nil {
		t.Fatal(err)
	}
	p.Prompt = "second"
	p.TurnKey = "second-turn"
	p.History = []string{"user-1", "assistant-1", "user-2"}
	if err := complete(p); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(paths) != 2 || paths[0] != paths[1] || bodies[1].Parent != bodies[0].Turns.Assistant {
		t.Error("conversation or parent UUID changed", paths, bodies)
	}
	mu.Unlock()
	if creates.Load() != 1 || deletes.Load() != 0 {
		t.Fatal("retained conversation was recreated/deleted")
	}
	if err := c.discard(context.Background(), completion{ConversationID: p.ConversationID, TurnKey: "old-turn"}); err != nil || deletes.Load() != 0 {
		t.Fatal("late discard deleted a newer successful turn", err)
	}
	if err := complete(p); publicError(err).Status != 409 {
		t.Fatalf("duplicate turn was replayed: %v", err)
	}
	p.Prompt = "edited"
	p.History = []string{"changed-user"}
	if err := complete(p); err != nil {
		t.Fatal(err)
	}
	if creates.Load() != 2 || deletes.Load() != 1 {
		t.Fatal("edited history reused the wrong branch")
	}
	p.Model = "different-model"
	p.Prompt = "switch"
	if err := complete(p); err != nil {
		t.Fatal(err)
	}
	if creates.Load() != 3 || deletes.Load() != 2 {
		t.Fatal("model switch did not reset the conversation")
	}
	closeClients([]*client{c})
	if deletes.Load() != 3 || len(c.conversations) != 0 {
		t.Fatal("shutdown retained conversations")
	}
}

func TestAccountRestrictionStopsRepeatedUpstreamRequests(t *testing.T) {
	for _, status := range []int{401, 403, 429} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Retry-After", "12")
				w.WriteHeader(status)
			}))
			defer server.Close()
			c, err := newClient(server.URL, "", credentials{Key: "test"})
			if err != nil {
				t.Fatal(err)
			}
			defer closeClients([]*client{c})
			_, err = c.models(context.Background())
			if err == nil || publicError(err).Status != status {
				t.Fatalf("unexpected initial failure: %v", err)
			}
			_, err = c.models(context.Background())
			if err == nil || publicError(err).Status != status {
				t.Fatalf("restriction lost: %v", err)
			}
			err = c.complete(context.Background(), completion{Model: "model", Prompt: "new request", ConversationID: "new-id"}, func() {}, func(json.RawMessage) error { return nil })
			if err == nil || publicError(err).Status != status || requests.Load() != 1 {
				t.Fatalf("repeated restricted account request: %v requests=%d", err, requests.Load())
			}
			if status == 429 && publicError(err).RetryAfter != "12" {
				t.Fatal("cooldown did not retain Retry-After", err)
			}
		})
	}
}

func TestAccountGuardSerializesAndCancelsWaiters(t *testing.T) {
	g := accountGuard{slot: make(chan struct{}, 1)}
	release, err := g.begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err = g.begin(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("blocked account wait could not be cancelled", err)
	}
	release()
	ctx, cancel2 := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel2()
	if _, err = g.begin(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("minimum-interval wait could not be cancelled", err)
	}
	ctx, cancel3 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel3()
	start := time.Now()
	release, err = g.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if time.Since(start) < 850*time.Millisecond {
		t.Fatal("account pacing was skipped")
	}
}

func TestRetryAfterBoundsAndDates(t *testing.T) {
	for _, input := range []string{"", "invalid", "-100", "9223372036854775807", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)} {
		g := accountGuard{}
		retry := g.observe(429, input)
		if retry == "" || g.until.Before(time.Now()) || time.Until(g.until) > 7*24*time.Hour {
			t.Fatalf("unbounded retry %q: %s", input, retry)
		}
	}
}

func TestConversationCapacityAndIdleExpiry(t *testing.T) {
	var creates, deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/organizations" {
			fmt.Fprint(w, `[{"uuid":"org"}]`)
			return
		}
		if r.Method == "DELETE" {
			deletes.Add(1)
			w.WriteHeader(204)
			return
		}
		fmt.Fprintf(w, `{"uuid":"conv-%d"}`, creates.Add(1))
	}))
	defer server.Close()
	c, err := newClient(server.URL, "", credentials{Key: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeClients([]*client{c})
	for i := 0; i < maxConversations+1; i++ {
		if _, err := c.conversation(context.Background(), completion{ConversationID: fmt.Sprint(i), Model: "model"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.conversations) != maxConversations || deletes.Load() != 1 {
		t.Fatal("conversation cache was not bounded")
	}
	for _, state := range c.conversations {
		state.used = time.Now().Add(-conversationTTL - time.Second)
	}
	if _, err := c.conversation(context.Background(), completion{ConversationID: "fresh", Model: "model"}); err != nil {
		t.Fatal(err)
	}
	if len(c.conversations) != 1 || deletes.Load() != maxConversations+1 {
		t.Fatal("idle conversations were retained")
	}
}

func TestRestrictionSharedAcrossCookieAndProxyChanges(t *testing.T) {
	p := &clientPool{}
	defer p.close()
	a, release, err := p.acquire("https://claude.ai", "", credentials{Key: "sessionKey=one; lastActiveOrg=a"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	a.guard.observe(429, "12")
	b, release, err := p.acquire("https://claude.ai", "direct", credentials{Key: "sessionKey=one; lastActiveOrg=b"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	if a == b || a.guard != b.guard || b.guard.restriction() == nil {
		t.Fatal("ancillary cookie/proxy change bypassed account cooldown")
	}
	c, release, err := p.acquire("https://claude.ai", "", credentials{Key: "other-account"})
	if err != nil {
		t.Fatal(err)
	}
	release()
	if c.guard == a.guard || c.guard.restriction() != nil {
		t.Fatal("another account inherited the restriction")
	}
}

func TestModelCacheAndStreamRestriction(t *testing.T) {
	var bootstrap, creates, deletes, streams atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/organizations":
			fmt.Fprint(w, `[{"uuid":"org"}]`)
		case strings.HasPrefix(r.URL.Path, "/edge-api/"):
			bootstrap.Add(1)
			fmt.Fprint(w, `{"claude_ai_available_models":{"models":[{"model_id":"model"}]}}`)
		case r.Method == "DELETE":
			deletes.Add(1)
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/completion"):
			streams.Add(1)
			fmt.Fprint(w, "data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n\n")
		default:
			fmt.Fprintf(w, `{"uuid":"conv-%d"}`, creates.Add(1))
		}
	}))
	defer server.Close()
	c, err := newClient(server.URL, "", credentials{Key: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeClients([]*client{c})
	ids, err := c.models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ids[0] = "mutated"
	ids, err = c.models(context.Background())
	if err != nil || ids[0] != "model" || bootstrap.Load() != 1 {
		t.Fatal("model cache missed or shared mutable data", ids, err)
	}
	p := completion{ConversationID: "dialogue", Model: "model", Prompt: "hello"}
	err = c.complete(context.Background(), p, func() {}, func(json.RawMessage) error { return nil })
	if err == nil || publicError(err).Status != 429 || publicError(err).RetryAfter != "60" {
		t.Fatal("stream restriction was not retained", err)
	}
	if len(c.conversations) != 0 || deletes.Load() != 0 {
		t.Fatal("failed stream was retained or cleanup ignored cooldown")
	}
	err = c.complete(context.Background(), p, func() {}, func(json.RawMessage) error { return nil })
	if err == nil || creates.Load() != 1 || streams.Load() != 1 {
		t.Fatal("restricted stream was retried", err)
	}
}
