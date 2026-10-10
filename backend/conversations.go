package main

import (
	"context"
	"crypto/sha256"
	"sync"
	"time"
)

const conversationTTL = 30 * time.Minute
const maxConversations = 16

type conversation struct {
	uuid, parent, model    string
	contextKey, requestKey string
	turnKey                string
	historyLength          int
	historyHash            [32]byte
	used                   time.Time
}

// Access is serialized by the account guard. No transcript or credentials are
// written to disk; memory and remote conversations are bounded per account.
func (c *client) conversation(ctx context.Context, p completion) (*conversation, error) {
	id, model := p.ConversationID, p.Model
	for key, state := range c.conversations {
		if time.Since(state.used) >= conversationTTL || key == id && (state.model != model || state.contextKey != p.ContextKey || !historyExtends(state, p.History)) {
			delete(c.conversations, key)
			c.delete(state.uuid)
		}
	}
	if state := c.conversations[id]; state != nil {
		return state, nil
	}
	if len(c.conversations) >= maxConversations {
		var oldestKey string
		var oldest *conversation
		for key, state := range c.conversations {
			if oldest == nil || state.used.Before(oldest.used) {
				oldestKey, oldest = key, state
			}
		}
		delete(c.conversations, oldestKey)
		c.delete(oldest.uuid)
	}
	uuid, err := c.create(ctx)
	if err != nil {
		return nil, err
	}
	state := &conversation{uuid: uuid, model: model, contextKey: p.ContextKey, used: time.Now()}
	c.conversations[id] = state
	return state, nil
}

func historyExtends(previous *conversation, next []string) bool {
	if previous.historyLength == 0 || len(next) == 0 {
		return true
	}
	if len(next) < previous.historyLength {
		return false
	}
	return historyHash(next[:previous.historyLength]) == previous.historyHash
}

func historyHash(items []string) [32]byte {
	hash := sha256.New()
	for _, item := range items {
		_, _ = hash.Write([]byte(item))
		_, _ = hash.Write([]byte{0})
	}
	var sum [32]byte
	copy(sum[:], hash.Sum(nil))
	return sum
}

func (c *client) forgetConversation(id string, state *conversation) {
	if c.conversations[id] == state {
		delete(c.conversations, id)
	}
	c.delete(state.uuid)
}

func (c *client) discard(ctx context.Context, p completion) error {
	select {
	case c.guard.slot <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-c.guard.slot }()
	if state := c.conversations[p.ConversationID]; state != nil && state.turnKey == p.TurnKey {
		c.forgetConversation(p.ConversationID, state)
	}
	return nil
}

// Shutdown cleanup shares one deadline; a stalled upstream cannot turn
// uninstall into an unbounded wait across many retained conversations.
func closeClients(clients []*client) {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	var work sync.WaitGroup
	jobs := make(chan func())
	for i := 0; i < 8; i++ {
		work.Add(1)
		go func() {
			defer work.Done()
			for job := range jobs {
				job()
			}
		}()
	}
	for _, c := range clients {
		for _, state := range c.conversations {
			select {
			case jobs <- func() { c.deleteWithContext(ctx, state.uuid) }:
			case <-ctx.Done():
			}
		}
		clear(c.conversations)
	}
	close(jobs)
	work.Wait()
	for _, c := range clients {
		c.http.CloseIdleConnections()
	}
}
