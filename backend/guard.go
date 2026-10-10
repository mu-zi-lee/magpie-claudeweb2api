package main

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Serialize each account independently. Repeated callers cannot bypass an
// upstream restriction by opening new conversations or changing model IDs.
type accountGuard struct {
	slot    chan struct{}
	mu      sync.Mutex
	blocked int
	until   time.Time
	next    time.Time
}

func (g *accountGuard) restriction() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.blocked != 0 {
		return &apiError{Status: g.blocked, Message: "Claude account access was refused; update credentials or resolve access in the browser"}
	}
	if left := time.Until(g.until); left > 0 {
		return &apiError{Status: 429, Message: "Claude account is cooling down after a rate limit", RetryAfter: strconv.Itoa(int(math.Ceil(left.Seconds())))}
	}
	return nil
}

func (g *accountGuard) begin(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := g.restriction(); err != nil {
		return nil, err
	}
	select {
	case g.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := g.restriction(); err != nil {
		<-g.slot
		return nil, err
	}
	g.mu.Lock()
	wait := time.Until(g.next)
	g.mu.Unlock()
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			<-g.slot
			return nil, ctx.Err()
		}
	}
	return func() {
		g.mu.Lock()
		g.next = time.Now().Add(time.Second)
		g.mu.Unlock()
		<-g.slot
	}, nil
}

func (g *accountGuard) observe(status int, retry string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch status {
	case 401, 403:
		g.blocked = status
	case 429:
		delay := time.Minute
		if seconds, err := strconv.ParseInt(strings.TrimSpace(retry), 10, 64); err == nil && seconds >= 0 {
			// Bound before multiplication to avoid duration overflow.
			if seconds > 7*24*3600 {
				seconds = 7 * 24 * 3600
			}
			delay = time.Duration(seconds) * time.Second
		} else if at, err := http.ParseTime(retry); err == nil {
			delay = time.Until(at)
		}
		if delay < time.Second {
			delay = time.Second
		}
		if delay > 7*24*time.Hour {
			delay = 7 * 24 * time.Hour
		}
		g.until = time.Now().Add(delay)
		return strconv.Itoa(int(math.Ceil(delay.Seconds())))
	}
	return ""
}
