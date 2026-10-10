package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
)

// Exercise the gateway's own reasoning conversion, then the real Bun plugin
// host and packaged Go backend. Live credentials are an explicit opt-in.
func TestClaudeWebPluginGatewayThinking(t *testing.T) {
	claudeWebGatewayThinking(t, false)
}

func TestClaudeWebPluginGatewayLiveThinking(t *testing.T) {
	if os.Getenv("CLAUDEWEB_LIVE_COOKIE_FILE") == "" {
		t.Skip("set CLAUDEWEB_LIVE_COOKIE_FILE to opt into real upstream requests")
	}
	claudeWebGatewayThinking(t, true)
}

func claudeWebGatewayThinking(t *testing.T, live bool) {
	t.Helper()
	source := os.Getenv("CLAUDEWEB_PLUGIN_SOURCE")
	if source == "" {
		t.Skip("run through the plugin's integration harness")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal("Bun is required for the real plugin host test")
	}
	fresh(t)
	t.Setenv("MAGPIE_BUN", bun)
	t.Cleanup(plugin.Settle)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	origin, key := "https://claude.ai", "sessionKey=fixture-account"
	if live {
		raw, err := os.ReadFile(os.Getenv("CLAUDEWEB_LIVE_COOKIE_FILE"))
		if err != nil {
			t.Fatal("cannot read the authorized Cookie file")
		}
		key = strings.TrimSpace(string(raw))
	} else {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/api/organizations":
				fmt.Fprint(w, `[{"uuid":"org"}]`)
			case strings.HasPrefix(r.URL.Path, "/edge-api/"):
				fmt.Fprint(w, `{"claude_ai_available_models":{"models":[{"model_id":"claude-haiku-5-5"},{"model_id":"claude-haiku-4-5-20251001"}]}}`)
			case r.Method == "DELETE":
				w.WriteHeader(204)
			case strings.HasSuffix(r.URL.Path, "/completion"):
				var body struct {
					Thinking string `json:"thinking_mode"`
					Effort   string `json:"effort"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Thinking != "auto" {
					w.WriteHeader(400)
					return
				}
				if body.Effort != "low" && body.Effort != "medium" && body.Effort != "high" {
					t.Error("gateway reasoning effort did not reach the web API")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"private web reasoning\"}}\n\n")
				fmt.Fprint(w, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n")
			default:
				fmt.Fprint(w, `{"uuid":"conversation"}`)
			}
		}))
		defer server.Close()
		origin = server.URL
	}
	if _, err := plugin.Add(ctx, source); err != nil {
		t.Fatal(err)
	}
	if err := plugin.SetOptions(source, map[string]any{"origin": origin, "proxy": "direct"}); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.PluginAPIKey(ctx, "claude-web", 0, nil, key); err != nil {
		t.Fatal("plugin sign-in failed")
	}
	for _, tc := range []struct{ model, effort, thinking string }{
		{"claude-haiku-5-5", "low", "adaptive"},
		{"claude-haiku-5-5", "medium", "adaptive"},
		{"claude-haiku-5-5", "high", "adaptive"},
		{"claude-haiku-4-5-20251001", "medium", "enabled"},
	} {
		t.Run(tc.model+"/"+tc.effort, func(t *testing.T) {
			body := buildAnthropic(&Request{Model: tc.model, MaxTokens: 4096, Stream: true, Effort: tc.effort, Messages: []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "Reply with exactly OK."}}}}}, tc.model)
			var rendered struct {
				Thinking struct {
					Type string `json:"type"`
				} `json:"thinking"`
			}
			if err := json.Unmarshal(body, &rendered); err != nil || rendered.Thinking.Type != tc.thinking {
				t.Fatalf("gateway generated thinking %q, want %q", rendered.Thinking.Type, tc.thinking)
			}
			res, err := plugin.Fetch(ctx, plugin.FetchRequest{Provider: "claude-web", Model: tc.model, NPM: "@ai-sdk/anthropic", URL: "https://claude-web.invalid/v1/messages", Body: body, Method: "POST"})
			if err != nil {
				t.Fatal("gateway plugin fetch failed")
			}
			defer res.Body.Close()
			raw, err := io.ReadAll(res.Body)
			if err != nil || res.StatusCode != 200 || !strings.Contains(string(raw), `"text":"OK"`) || !strings.Contains(string(raw), "event: message_stop") || strings.Contains(string(raw), "event: error") {
				t.Fatalf("gateway completion failed: HTTP %d", res.StatusCode)
			}
			if strings.Contains(string(raw), "thinking_delta") || strings.Contains(string(raw), "private web reasoning") {
				t.Fatal("unsigned web thinking leaked into the API response")
			}
			t.Log("gateway renderer -> Bun plugin host -> Go backend: HTTP 200, OK, message_stop")
		})
	}
}
