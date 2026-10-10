package main

import (
	"crypto/sha256"
	"strings"
	"sync"
	"time"
)

type pooledClient struct {
	client *client
	refs   int
	used   time.Time
}

// Browser identity and organization are reused per credential and proxy, only
// in this process's memory. Idle accounts are evicted rather than growing forever.
type clientPool struct {
	mu      sync.Mutex
	clients map[[32]byte]*pooledClient
	guards  map[[32]byte]*accountGuard
}

func (p *clientPool) acquire(origin, proxy string, auth credentials) (*client, func(), error) {
	key := sha256.Sum256([]byte(origin + "\x00" + proxy + "\x00" + auth.Key))
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.clients == nil {
		p.clients = make(map[[32]byte]*pooledClient)
	}
	if p.guards == nil {
		p.guards = make(map[[32]byte]*accountGuard)
	}
	entry := p.clients[key]
	if entry == nil {
		if len(p.clients) >= 64 {
			var victim [32]byte
			var oldest *pooledClient
			for k, e := range p.clients {
				if e.refs == 0 && (oldest == nil || e.used.Before(oldest.used)) {
					victim, oldest = k, e
				}
			}
			if oldest == nil {
				return nil, nil, &apiError{Status: 503, Message: "Backend account capacity is busy"}
			}
			closeClients([]*client{oldest.client})
			delete(p.clients, victim)
		}
		c, err := newClient(origin, proxy, auth)
		if err != nil {
			return nil, nil, err
		}
		// The login's sessionKey identifies the account even if ancillary cookies
		// or the proxy change. Share pacing and restrictions across transports.
		session := strings.TrimSpace(auth.Key)
		if strings.Contains(session, "=") {
			session = cookieValue(session, "sessionKey")
		}
		owner := sha256.Sum256([]byte(origin + "\x00" + session))
		guard := p.guards[owner]
		if guard == nil {
			if len(p.guards) >= 64 {
				for id, candidate := range p.guards {
					used := false
					for _, entry := range p.clients {
						if entry.client.guard == candidate {
							used = true
							break
						}
					}
					if !used && candidate.restriction() == nil {
						delete(p.guards, id)
						break
					}
				}
				if len(p.guards) >= 64 {
					c.http.CloseIdleConnections()
					return nil, nil, &apiError{Status: 503, Message: "Backend account protection capacity is busy"}
				}
			}
			guard = c.guard
			p.guards[owner] = guard
		}
		c.guard = guard
		entry = &pooledClient{client: c}
		p.clients[key] = entry
	}
	entry.refs++
	return entry.client, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		entry.refs--
		entry.used = time.Now()
	}, nil
}

func (p *clientPool) close() {
	clients := make([]*client, 0, len(p.clients))
	for _, e := range p.clients {
		clients = append(clients, e.client)
	}
	closeClients(clients)
	clear(p.clients)
	clear(p.guards)
}
