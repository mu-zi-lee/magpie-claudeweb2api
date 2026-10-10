package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/plugin"
)

// This uses the actual packaged plugin, actual Bun host and Go transport. Only
// claude.ai is replaced by a loopback HTTP server; credentials are invented.
func TestClaudeWebPluginStockInstallRequestAndRemove(t *testing.T) {
	source := os.Getenv("CLAUDEWEB_PLUGIN_SOURCE")
	if source == "" {
		t.Skip("run through npm run test:magpie to provide the built plugin")
	}
	claudeHome(t)
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun is required for the real plugin host test")
	}
	t.Setenv("MAGPIE_BUN", bun)
	t.Cleanup(plugin.Settle)
	const pkg = "magpie-claudeweb2api"
	// Serve the actual npm pack output. This exercises Bun's download, package
	// installation, hashed index and executable permissions, not a copied folder.
	archive, err := os.ReadFile(filepath.Join(source, pkg+"-0.1.0.tgz"))
	if err != nil {
		t.Fatal("build and npm pack the release before this test", err)
	}
	var deleted atomic.Int32
	var completions atomic.Int32
	var creates atomic.Int32
	var sessionPath, sessionAssistant atomic.Value
	marker := filepath.Join(t.TempDir(), "must-not-be-written-by-the-backend")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/plugin.tgz" {
			w.Write(archive)
			return
		}
		if r.URL.Path == "/registry/"+pkg {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"name": pkg, "dist-tags": map[string]string{"latest": "0.1.0"}, "versions": map[string]any{"0.1.0": map[string]any{"name": pkg, "version": "0.1.0", "dist": map[string]string{"tarball": server.URL + "/plugin.tgz"}}}})
			return
		}
		if !strings.Contains(r.Header.Get("Cookie"), "sessionKey=fixture-account") {
			t.Error("fixture account did not reach the transport")
		}
		switch {
		case r.URL.Path == "/api/organizations":
			fmt.Fprint(w, `[{"uuid":"org"},{"uuid":"active"}]`)
		case strings.HasPrefix(r.URL.Path, "/edge-api/"):
			if !strings.Contains(r.URL.Path, "/bootstrap/active/") {
				t.Error("active organization was ignored")
			}
			fmt.Fprint(w, `{"claude_ai_available_models":{"models":[{"model_id":"fixture-model"}]}}`)
		case r.Method == "DELETE":
			deleted.Add(1)
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/completion"):
			if !strings.HasPrefix(r.URL.Path, "/api/organizations/active/") {
				t.Error("completion used the wrong organization")
			}
			var body struct {
				Prompt string `json:"prompt"`
				Parent string `json:"parent_message_uuid"`
				Turns  struct {
					Assistant string `json:"assistant_message_uuid"`
				} `json:"turn_message_uuids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			text := "真实宿主链路"
			n := completions.Add(1)
			if n == 5 {
				sessionPath.Store(r.URL.Path)
				sessionAssistant.Store(body.Turns.Assistant)
			}
			if n == 6 && (sessionPath.Load() != r.URL.Path || sessionAssistant.Load() != body.Parent) {
				t.Error("host session did not reuse the web conversation and parent")
			}
			if n == 2 {
				re := regexp.MustCompile(`\[MAGPIE_TOOL_[a-f0-9]+\]`)
				start := re.FindString(body.Prompt)
				if start == "" {
					t.Error("tool definitions did not reach Claude")
				}
				args, _ := json.Marshal(map[string]any{"name": "Write", "input": map[string]any{"file_path": marker, "content": "never execute"}})
				text = start + string(args) + strings.Replace(start, "[", "[/", 1)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			if strings.Contains(body.Prompt, "stop-fixture") {
				for _, chunk := range []string{"保留<EN", "D>隐藏"} {
					payload, _ := json.Marshal(map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "text_delta", "text": chunk}})
					fmt.Fprintf(w, "data: %s\n\n", payload)
				}
				fmt.Fprint(w, "data: {\"type\":\"message_stop\"}\n\n")
				return
			}
			payload, _ := json.Marshal(map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "text_delta", "text": text}})
			fmt.Fprintf(w, "event: content_block_delta\ndata: %s\n\n", payload)
			if strings.Contains(body.Prompt, "refusal-fixture") {
				fmt.Fprint(w, "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\n")
			}
			fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		default:
			fmt.Fprintf(w, `{"uuid":"conversation-%d"}`, creates.Add(1))
		}
	}))
	defer server.Close()
	target := plugin.Target(pkg)
	t.Setenv("BUN_CONFIG_REGISTRY", server.URL+"/registry/")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := plugin.Add(ctx, pkg+"@0.1.0"); err != nil {
		t.Fatal(err)
	}
	if err := plugin.SetOptions(pkg, map[string]any{"origin": server.URL, "proxy": "direct"}); err != nil {
		t.Fatal(err)
	}
	cacheRoot := filepath.Join(appdir.Cache(), "bun", "install-cache")
	if entries, err := os.ReadDir(cacheRoot); err != nil || len(entries) < 3 {
		t.Fatal("actual downloaded package/index cache was not created", err)
	}
	ps, err := plugin.Providers(ctx)
	if err != nil || len(ps) != 1 || ps[0].ID != "claude-web" {
		t.Fatalf("provider registration: %+v %v", ps, err)
	}
	if !strings.HasPrefix(ps[0].Icon, "data:image/png;base64,") {
		t.Fatal("packaged plugin did not provide its local icon")
	}
	icon := PluginIcon(ps[0])
	if !strings.HasPrefix(icon, "file:") {
		t.Fatalf("Magpie could not store the plugin icon: %q", icon)
	}
	actualIcon, err := os.ReadFile(IconFile(strings.TrimPrefix(icon, "file:")))
	if err != nil {
		t.Fatal(err)
	}
	wantIcon, err := os.ReadFile(filepath.Join(source, "assets", "icon-small.png"))
	if err != nil || !bytes.Equal(actualIcon, wantIcon) {
		t.Fatal("stored icon does not match the bundled image", err)
	}
	if _, err := PluginAPIKey(ctx, "claude-web", 0, nil, "sessionKey=fixture-account; lastActiveOrg=active"); err != nil {
		t.Fatal(err)
	}
	ps, err = plugin.Providers(ctx)
	if err != nil || len(ps) != 1 || len(ps[0].Models) != 1 || ps[0].Models[0].ID != "fixture-model" {
		t.Fatalf("account models: %+v %v", ps, err)
	}
	request := func(body string, session ...string) []byte {
		id := ""
		if len(session) > 0 {
			id = session[0]
		}
		res, err := plugin.Fetch(ctx, plugin.FetchRequest{Provider: "claude-web", Model: "fixture-model", NPM: "@ai-sdk/anthropic", URL: "https://claude-web.invalid/v1/messages", Body: []byte(body), Method: "POST", Session: id})
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("fetch: %s %v status %d", b, err, res.StatusCode)
		}
		return b
	}
	text := request(`{"model":"fixture-model","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hello"}]}`)
	if !strings.Contains(string(text), "真实宿主链路") || !strings.Contains(string(text), "event: message_stop") {
		t.Fatalf("stream: %s", text)
	}
	tool := request(`{"model":"fixture-model","max_tokens":1000,"messages":[{"role":"user","content":"write"}],"tools":[{"name":"Write","input_schema":{"type":"object","required":["file_path","content"]}}]}`)
	if !strings.Contains(string(tool), `"stop_reason":"tool_use"`) || !strings.Contains(string(tool), marker) {
		t.Fatalf("tool response: %s", tool)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("backend executed a client tool", err)
	}
	stop := request(`{"model":"fixture-model","max_tokens":100,"stop_sequences":["<END>"],"messages":[{"role":"user","content":"stop-fixture"}]}`)
	var stopped struct {
		StopReason   string `json:"stop_reason"`
		StopSequence string `json:"stop_sequence"`
		Content      []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(stop, &stopped); err != nil || stopped.StopReason != "stop_sequence" || stopped.StopSequence != "<END>" || len(stopped.Content) != 1 || stopped.Content[0].Text != "保留" {
		t.Fatalf("stop sequence: %s %v", stop, err)
	}
	refusal := request(`{"model":"fixture-model","max_tokens":100,"messages":[{"role":"user","content":"refusal-fixture"}]}`)
	if !strings.Contains(string(refusal), `"stop_reason":"refusal"`) {
		t.Fatalf("refusal reason was lost: %s", refusal)
	}
	request(`{"model":"fixture-model","max_tokens":100,"messages":[{"role":"user","content":"session-first"}]}`, "fixture-session")
	request(`{"model":"fixture-model","max_tokens":100,"messages":[{"role":"user","content":"session-first"},{"role":"assistant","content":"真实宿主链路"},{"role":"user","content":"session-second"}]}`, "fixture-session")
	if creates.Load() != 5 || deleted.Load() != 4 {
		t.Fatalf("session reuse: creates=%d deletes=%d", creates.Load(), deleted.Load())
	}
	// Force the provider display layer to keep its ordinary login metadata too.
	if ls := pluginLogins(ps[0]); len(ls) != 1 {
		t.Fatalf("display account: %+v", ls)
	}
	if err := RemovePlugin(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("installed backend survived uninstall", err)
	}
	if len(plugin.Load().Plugins) != 0 {
		t.Fatal("plugin registration survived uninstall")
	}
	// Stock removal owns package/registration cleanup. Shared credentials,
	// account metadata and download caches follow Magpie's own behavior.
	// Retiring Bun hosts close their pipes; no custom lifecycle hook is used.
	plugin.Settle()
	deadline := time.Now().Add(3 * time.Second)
	for deleted.Load() < 5 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	for _, name := range []string{"package.json", "bun.lock", "bun.lockb"} {
		data, err := os.ReadFile(filepath.Join(plugin.Dir(), name))
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(pkg)) {
			t.Fatalf("installed dependency reference survived in %s", name)
		}
	}
	if deleted.Load() != 5 {
		t.Fatalf("temporary conversations deleted = %d", deleted.Load())
	}
}
