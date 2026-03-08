package main

import (
	"log/slog"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// RelayConfig holds relay server configuration.
type RelayConfig struct {
	MaxChannels     int
	MaxClientsPerCh int
	RateLimit       int // messages per second per channel
	MaxPayload      int // max payload bytes
	Public          bool
}

// clientConn represents a connected client in a channel.
type clientConn struct {
	id   string
	conn *websocket.Conn
}

// channel represents a relay channel with a gateway and zero or more clients.
type channel struct {
	mu          sync.RWMutex
	hash        string
	gateway     *websocket.Conn
	clients     map[string]*clientConn
	limiter     *tokenBucket
	createdAt   time.Time
}

// Relay is the core relay server managing channels and connections.
type Relay struct {
	config RelayConfig
	logger *slog.Logger

	mu       sync.RWMutex
	channels map[string]*channel

	framesForwarded int64
	framesRejected  int64
}

// NewRelay creates a new Relay instance.
func NewRelay(config RelayConfig, logger *slog.Logger) *Relay {
	return &Relay{
		config:   config,
		logger:   logger,
		channels: make(map[string]*channel),
	}
}

// RegisterGateway registers a gateway on the given channel hash.
// Returns the channel and an error code if registration fails.
func (r *Relay) RegisterGateway(channelHash string, conn *websocket.Conn) (*channel, string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if ch, exists := r.channels[channelHash]; exists {
		ch.mu.RLock()
		hasGateway := ch.gateway != nil
		ch.mu.RUnlock()
		if hasGateway {
			return nil, "channel_occupied"
		}
	}

	if len(r.channels) >= r.config.MaxChannels {
		// Check if this channel already exists (gateway reconnect to existing channel).
		if _, exists := r.channels[channelHash]; !exists {
			return nil, "channel_limit_reached"
		}
	}

	ch, exists := r.channels[channelHash]
	if !exists {
		ch = &channel{
			hash:      channelHash,
			clients:   make(map[string]*clientConn),
			limiter:   newTokenBucket(r.config.RateLimit),
			createdAt: time.Now(),
		}
		r.channels[channelHash] = ch
	}

	ch.mu.Lock()
	ch.gateway = conn
	ch.mu.Unlock()

	r.logger.Info("channel.registered", "channel_hash", channelHash[:min(12, len(channelHash))])
	return ch, ""
}

// JoinClient adds a client to a channel.
// Returns the channel, whether the gateway is online, and an error code.
func (r *Relay) JoinClient(channelHash, clientID string, conn *websocket.Conn) (*channel, bool, string) {
	r.mu.Lock()

	ch, exists := r.channels[channelHash]
	if !exists {
		// Create channel without gateway; client can wait.
		if len(r.channels) >= r.config.MaxChannels {
			r.mu.Unlock()
			return nil, false, "channel_limit_reached"
		}
		ch = &channel{
			hash:      channelHash,
			clients:   make(map[string]*clientConn),
			limiter:   newTokenBucket(r.config.RateLimit),
			createdAt: time.Now(),
		}
		r.channels[channelHash] = ch
	}
	r.mu.Unlock()

	ch.mu.Lock()
	defer ch.mu.Unlock()

	if len(ch.clients) >= r.config.MaxClientsPerCh {
		// Allow replacing an existing client_id (doesn't count as a new slot).
		if _, replacing := ch.clients[clientID]; !replacing {
			return nil, false, "channel_full"
		}
	}

	// If this client_id is already connected, close the old connection.
	// Its read-loop goroutine will eventually call RemoveClient, but
	// the ownership check there will prevent it from removing the new conn.
	if old, exists := ch.clients[clientID]; exists {
		old.conn.Close(websocket.StatusNormalClosure, "replaced by new connection")
	}

	ch.clients[clientID] = &clientConn{id: clientID, conn: conn}
	gatewayOnline := ch.gateway != nil

	r.logger.Info("client.joined",
		"channel_hash", channelHash[:min(12, len(channelHash))],
		"client_id", clientID,
	)
	return ch, gatewayOnline, ""
}

// RemoveGateway removes the gateway from a channel and cleans up.
func (r *Relay) RemoveGateway(channelHash string) {
	r.mu.Lock()
	ch, exists := r.channels[channelHash]
	if !exists {
		r.mu.Unlock()
		return
	}

	ch.mu.Lock()
	ch.gateway = nil
	// Collect client connections to notify.
	clients := make([]*clientConn, 0, len(ch.clients))
	for _, c := range ch.clients {
		clients = append(clients, c)
	}
	ch.mu.Unlock()

	// If no clients remain, remove the channel entirely.
	if len(clients) == 0 {
		duration := time.Since(ch.createdAt).Seconds()
		ch.limiter.stop()
		delete(r.channels, channelHash)
		r.mu.Unlock()
		r.logger.Info("channel.closed",
			"channel_hash", channelHash[:min(12, len(channelHash))],
			"duration_seconds", int(duration),
		)
		return
	}
	r.mu.Unlock()

	// Notify all clients that gateway went offline.
	presenceMsg := Frame{
		Type:     "presence",
		Role:     "gateway",
		Status:   "offline",
	}
	for _, c := range clients {
		writeJSON(c.conn, presenceMsg)
	}
}

// RemoveClient removes a client from a channel.
// The conn parameter is used for ownership verification: the client slot is
// only removed if it still belongs to this specific connection. This prevents
// a stale goroutine (from a replaced connection) from removing a newer one.
func (r *Relay) RemoveClient(channelHash, clientID string, conn *websocket.Conn, reason string) {
	r.mu.Lock()
	ch, exists := r.channels[channelHash]
	if !exists {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	ch.mu.Lock()
	// Only remove if this connection still owns the slot.
	current, exists := ch.clients[clientID]
	if !exists || current.conn != conn {
		ch.mu.Unlock()
		return
	}
	delete(ch.clients, clientID)
	gw := ch.gateway
	remainingClients := len(ch.clients)
	ch.mu.Unlock()

	r.logger.Info("client.left",
		"channel_hash", channelHash[:min(12, len(channelHash))],
		"client_id", clientID,
		"reason", reason,
	)

	// Notify gateway that client left.
	if gw != nil {
		presenceMsg := Frame{
			Type:     "presence",
			Role:     "client",
			Status:   "offline",
			ClientID: clientID,
		}
		writeJSON(gw, presenceMsg)
	}

	// If channel has no gateway and no clients, remove it.
	if gw == nil && remainingClients == 0 {
		r.mu.Lock()
		ch2, exists := r.channels[channelHash]
		if exists && ch2 == ch {
			duration := time.Since(ch.createdAt).Seconds()
			ch.limiter.stop()
			delete(r.channels, channelHash)
			r.logger.Info("channel.closed",
				"channel_hash", channelHash[:min(12, len(channelHash))],
				"duration_seconds", int(duration),
			)
		}
		r.mu.Unlock()
	}
}

// ClientCount returns the number of clients in a channel.
func (r *Relay) ClientCount(channelHash string) int {
	r.mu.RLock()
	ch, exists := r.channels[channelHash]
	r.mu.RUnlock()
	if !exists {
		return 0
	}
	ch.mu.RLock()
	defer ch.mu.RUnlock()
	return len(ch.clients)
}

// ChannelCount returns the number of active channels.
func (r *Relay) ChannelCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.channels)
}

// ConnectionCount returns the total number of connections (gateways + clients).
func (r *Relay) ConnectionCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	total := 0
	for _, ch := range r.channels {
		ch.mu.RLock()
		if ch.gateway != nil {
			total++
		}
		total += len(ch.clients)
		ch.mu.RUnlock()
	}
	return total
}

// CloseAll closes all connections with Going Away status.
func (r *Relay) CloseAll() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, ch := range r.channels {
		ch.mu.Lock()
		if ch.gateway != nil {
			ch.gateway.Close(websocket.StatusGoingAway, "server shutting down")
		}
		for _, c := range ch.clients {
			c.conn.Close(websocket.StatusGoingAway, "server shutting down")
		}
		ch.limiter.stop()
		ch.mu.Unlock()
	}
	r.channels = make(map[string]*channel)
}

// tokenBucket implements a simple token bucket rate limiter.
type tokenBucket struct {
	mu       sync.Mutex
	tokens   int
	max      int
	ticker   *time.Ticker
	done     chan struct{}
}

func newTokenBucket(rate int) *tokenBucket {
	tb := &tokenBucket{
		tokens: rate,
		max:    rate,
		ticker: time.NewTicker(time.Second),
		done:   make(chan struct{}),
	}
	go tb.refill()
	return tb
}

func (tb *tokenBucket) refill() {
	for {
		select {
		case <-tb.ticker.C:
			tb.mu.Lock()
			tb.tokens = tb.max
			tb.mu.Unlock()
		case <-tb.done:
			return
		}
	}
}

// allow returns true if a token is available, consuming one.
func (tb *tokenBucket) allow() bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	if tb.tokens <= 0 {
		return false
	}
	tb.tokens--
	return true
}

func (tb *tokenBucket) stop() {
	tb.ticker.Stop()
	select {
	case <-tb.done:
		// Already closed.
	default:
		close(tb.done)
	}
}
