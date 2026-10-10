package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type command struct {
	ID         string      `json:"id"`
	Method     string      `json:"method"`
	Auth       credentials `json:"auth"`
	Origin     string      `json:"origin"`
	Proxy      string      `json:"proxy"`
	Completion completion  `json:"completion"`
}
type writer struct {
	mu  sync.Mutex
	out io.Writer
}

func (w *writer) send(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	enc := json.NewEncoder(w.out)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// No listening port, credential file, detached child, runtime download, or disk cache.
// EOF on the owner's pipe cancels work even if its process was killed abruptly.
func serve(ctx context.Context, in io.Reader, out io.Writer) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	w := &writer{out: out}
	_ = w.send(map[string]any{"event": "ready", "protocol": 1})
	var mu sync.Mutex
	pending := map[string]context.CancelFunc{}
	var work sync.WaitGroup
	pool := &clientPool{}
	defer pool.close()
	// Bound concurrency and memory, independently of Magpie's account limits.
	slots := make(chan struct{}, 16)
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		var cmd command
		if json.Unmarshal(scanner.Bytes(), &cmd) != nil || cmd.ID == "" {
			continue
		}
		mu.Lock()
		if cmd.Method == "abort" {
			if c := pending[cmd.ID]; c != nil {
				c()
			}
			mu.Unlock()
			continue
		}
		if _, exists := pending[cmd.ID]; exists {
			mu.Unlock()
			continue
		}
		if len(pending) >= 64 {
			mu.Unlock()
			_ = w.send(map[string]any{"id": cmd.ID, "error": &apiError{Status: 429, Message: "Backend request capacity is busy", RetryAfter: "1"}})
			continue
		}
		reqCtx, stop := context.WithTimeout(ctx, 5*time.Minute)
		pending[cmd.ID] = stop
		mu.Unlock()
		work.Add(1)
		go func(cmd command) {
			defer work.Done()
			defer func() { stop(); mu.Lock(); delete(pending, cmd.ID); mu.Unlock() }()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-reqCtx.Done():
				_ = w.send(map[string]any{"id": cmd.ID, "error": publicError(reqCtx.Err())})
				return
			}
			origin := cmd.Origin
			if origin == "" {
				origin = "https://claude.ai"
			}
			c, release, err := pool.acquire(origin, cmd.Proxy, cmd.Auth)
			if err == nil {
				defer release()
				switch cmd.Method {
				case "discard":
					err = c.discard(reqCtx, cmd.Completion)
					if err == nil {
						_ = w.send(map[string]any{"id": cmd.ID, "result": true})
					}
				case "models":
					var ids []string
					ids, err = c.models(reqCtx)
					if err == nil {
						_ = w.send(map[string]any{"id": cmd.ID, "result": ids})
					}
				case "complete":
					err = c.complete(reqCtx, cmd.Completion,
						func() { _ = w.send(map[string]any{"id": cmd.ID, "event": "head", "status": 200}) },
						func(raw json.RawMessage) error {
							return w.send(map[string]any{"id": cmd.ID, "event": "data", "data": raw})
						})
					if err == nil {
						_ = w.send(map[string]any{"id": cmd.ID, "event": "done"})
					}
				default:
					err = &apiError{Status: 400, Message: "Unknown backend method"}
				}
			}
			if err != nil {
				_ = w.send(map[string]any{"id": cmd.ID, "error": publicError(err)})
			}
		}(cmd)
	}
	cancel()
	mu.Lock()
	for _, stop := range pending {
		stop()
	}
	mu.Unlock()
	work.Wait()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Interrupt a blocked stdin read on termination as well as cancelling requests.
	go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
	serve(ctx, os.Stdin, os.Stdout)
}
