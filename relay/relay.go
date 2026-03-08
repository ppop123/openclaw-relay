package main

import (
	"encoding/json"
	"log/slog"
	"sort"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const (
	maxSignalsPerMinute      = 10
	maxPendingInvitesPerPeer = 10
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
	mu        sync.RWMutex
	hash      string
	gateway   *websocket.Conn
	clients   map[string]*clientConn
	limiter   *tokenBucket
	createdAt time.Time
}

type discoveryEntry struct {
	publicKey    string
	channelHash  string
	metadata     json.RawMessage
	registeredAt time.Time
	conn         *websocket.Conn
}

type inviteEntry struct {
	inviteHash       string
	ownerPublicKey   string
	ownerChannelHash string
	expiresAt        time.Time
	remainingUses    int
}

// Relay is the core relay server managing channels and connections.
type Relay struct {
	config RelayConfig
	logger *slog.Logger

	mu              sync.RWMutex
	channels        map[string]*channel
	discoveryByKey  map[string]*discoveryEntry
	discoveryByConn map[*websocket.Conn]*discoveryEntry
	invites         map[string]*inviteEntry
	signalLimiters  map[*websocket.Conn]*tokenBucket

	framesForwarded int64
	framesRejected  int64
}

// NewRelay creates a new Relay instance.
func NewRelay(config RelayConfig, logger *slog.Logger) *Relay {
	return &Relay{
		config:          config,
		logger:          logger,
		channels:        make(map[string]*channel),
		discoveryByKey:  make(map[string]*discoveryEntry),
		discoveryByConn: make(map[*websocket.Conn]*discoveryEntry),
		invites:         make(map[string]*inviteEntry),
		signalLimiters:  make(map[*websocket.Conn]*tokenBucket),
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

func (r *Relay) BindGatewayDiscovery(channelHash string, conn *websocket.Conn, publicKey string, metadata json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if existing, ok := r.discoveryByConn[conn]; ok {
		if current, ok := r.discoveryByKey[existing.publicKey]; ok && current == existing {
			delete(r.discoveryByKey, existing.publicKey)
		}
		delete(r.discoveryByConn, conn)
	}
	if limiter, ok := r.signalLimiters[conn]; ok {
		limiter.stop()
		delete(r.signalLimiters, conn)
	}

	if old, ok := r.discoveryByKey[publicKey]; ok && old.conn != conn {
		delete(r.discoveryByConn, old.conn)
		if limiter, ok := r.signalLimiters[old.conn]; ok {
			limiter.stop()
			delete(r.signalLimiters, old.conn)
		}
	}

	entry := &discoveryEntry{
		publicKey:    publicKey,
		channelHash:  channelHash,
		metadata:     copyRawMessage(metadata),
		registeredAt: time.Now().UTC(),
		conn:         conn,
	}
	r.discoveryByKey[publicKey] = entry
	r.discoveryByConn[conn] = entry
	r.signalLimiters[conn] = newIntervalTokenBucket(maxSignalsPerMinute, time.Minute)
}

func (r *Relay) DiscoveryIdentityForConn(conn *websocket.Conn) (*discoveryEntry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry, ok := r.discoveryByConn[conn]
	if !ok {
		return nil, false
	}
	copy := *entry
	copy.metadata = copyRawMessage(entry.metadata)
	return &copy, true
}

func (r *Relay) LookupDiscoveryTarget(publicKey string) (*discoveryEntry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry, ok := r.discoveryByKey[publicKey]
	if !ok {
		return nil, false
	}
	copy := *entry
	copy.metadata = copyRawMessage(entry.metadata)
	return &copy, true
}

func (r *Relay) ListDiscoverablePeers(excludeConn *websocket.Conn) []DiscoveryPeer {
	r.mu.RLock()
	peers := make([]DiscoveryPeer, 0, len(r.discoveryByKey))
	for _, entry := range r.discoveryByKey {
		if entry.conn == excludeConn {
			continue
		}
		peers = append(peers, DiscoveryPeer{
			PublicKey:   entry.publicKey,
			Metadata:    copyRawMessage(entry.metadata),
			OnlineSince: entry.registeredAt.Format(time.RFC3339),
		})
	}
	r.mu.RUnlock()

	sort.Slice(peers, func(i, j int) bool {
		return peers[i].PublicKey < peers[j].PublicKey
	})
	return peers
}

func (r *Relay) AllowSignal(conn *websocket.Conn) bool {
	r.mu.RLock()
	limiter, ok := r.signalLimiters[conn]
	r.mu.RUnlock()
	if !ok {
		return false
	}
	return limiter.allow()
}

func (r *Relay) CreateInvite(conn *websocket.Conn, inviteHash string, maxUses, ttlSeconds int) (time.Time, string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.pruneExpiredInvitesLocked(time.Now())

	owner, ok := r.discoveryByConn[conn]
	if !ok {
		return time.Time{}, "not_discoverable"
	}
	if _, exists := r.invites[inviteHash]; exists {
		return time.Time{}, "invalid_frame"
	}

	pending := 0
	for _, invite := range r.invites {
		if invite.ownerPublicKey == owner.publicKey {
			pending++
		}
	}
	if pending >= maxPendingInvitesPerPeer {
		return time.Time{}, "invite_limit_reached"
	}

	expiresAt := time.Now().Add(time.Duration(ttlSeconds) * time.Second).UTC()
	r.invites[inviteHash] = &inviteEntry{
		inviteHash:       inviteHash,
		ownerPublicKey:   owner.publicKey,
		ownerChannelHash: owner.channelHash,
		expiresAt:        expiresAt,
		remainingUses:    maxUses,
	}
	return expiresAt, ""
}

// JoinClient adds a client to a channel.
// Returns the channel, whether the gateway is online, and an error code.
func (r *Relay) JoinClient(channelHash, clientID string, conn *websocket.Conn) (*channel, bool, string) {
	r.mu.Lock()
	resolvedChannelHash, errCode := r.resolveJoinChannelLocked(channelHash)
	if errCode != "" {
		r.mu.Unlock()
		return nil, false, errCode
	}

	ch, exists := r.channels[resolvedChannelHash]
	if !exists {
		if len(r.channels) >= r.config.MaxChannels {
			r.mu.Unlock()
			return nil, false, "channel_limit_reached"
		}
		ch = &channel{
			hash:      resolvedChannelHash,
			clients:   make(map[string]*clientConn),
			limiter:   newTokenBucket(r.config.RateLimit),
			createdAt: time.Now(),
		}
		r.channels[resolvedChannelHash] = ch
	}
	r.mu.Unlock()

	ch.mu.Lock()
	defer ch.mu.Unlock()

	if len(ch.clients) >= r.config.MaxClientsPerCh {
		if _, replacing := ch.clients[clientID]; !replacing {
			return nil, false, "channel_full"
		}
	}

	if old, exists := ch.clients[clientID]; exists {
		old.conn.Close(websocket.StatusNormalClosure, "replaced by new connection")
	}

	ch.clients[clientID] = &clientConn{id: clientID, conn: conn}
	gatewayOnline := ch.gateway != nil

	r.logger.Info("client.joined",
		"channel_hash", resolvedChannelHash[:min(12, len(resolvedChannelHash))],
		"client_id", clientID,
	)
	return ch, gatewayOnline, ""
}

// RemoveGateway removes the gateway from a channel and cleans up.
func (r *Relay) RemoveGateway(channelHash string, conn *websocket.Conn) {
	r.mu.Lock()
	ch, exists := r.channels[channelHash]
	if !exists {
		r.mu.Unlock()
		return
	}

	ch.mu.Lock()
	if ch.gateway != conn {
		ch.mu.Unlock()
		r.mu.Unlock()
		return
	}
	ch.gateway = nil
	clients := make([]*clientConn, 0, len(ch.clients))
	for _, c := range ch.clients {
		clients = append(clients, c)
	}
	ch.mu.Unlock()

	r.unbindGatewayDiscoveryLocked(conn, channelHash)

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

	presenceMsg := Frame{
		Type:   "presence",
		Role:   "gateway",
		Status: "offline",
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

	if gw != nil {
		presenceMsg := Frame{
			Type:     "presence",
			Role:     "client",
			Status:   "offline",
			ClientID: clientID,
		}
		writeJSON(gw, presenceMsg)
	}

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

func (r *Relay) resolveJoinChannelLocked(channelHash string) (string, string) {
	r.pruneExpiredInvitesLocked(time.Now())
	invite, exists := r.invites[channelHash]
	if !exists {
		return channelHash, ""
	}
	if _, ok := r.channels[invite.ownerChannelHash]; !ok {
		delete(r.invites, channelHash)
		return "", "invite_invalid"
	}
	if invite.remainingUses <= 0 {
		return "", "invite_invalid"
	}
	invite.remainingUses--
	return invite.ownerChannelHash, ""
}

func (r *Relay) pruneExpiredInvitesLocked(now time.Time) {
	for hash, invite := range r.invites {
		if !invite.expiresAt.After(now) {
			delete(r.invites, hash)
		}
	}
}

func (r *Relay) unbindGatewayDiscoveryLocked(conn *websocket.Conn, channelHash string) {
	entry, ok := r.discoveryByConn[conn]
	if ok {
		if current, exists := r.discoveryByKey[entry.publicKey]; exists && current == entry {
			delete(r.discoveryByKey, entry.publicKey)
		}
		delete(r.discoveryByConn, conn)
		r.removeInvitesForOwnerLocked(entry.publicKey, channelHash)
	}
	if limiter, ok := r.signalLimiters[conn]; ok {
		limiter.stop()
		delete(r.signalLimiters, conn)
	}
}

func (r *Relay) removeInvitesForOwnerLocked(ownerPublicKey, ownerChannelHash string) {
	for hash, invite := range r.invites {
		if invite.ownerPublicKey == ownerPublicKey || invite.ownerChannelHash == ownerChannelHash {
			delete(r.invites, hash)
		}
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
	for _, limiter := range r.signalLimiters {
		limiter.stop()
	}
	r.channels = make(map[string]*channel)
	r.discoveryByKey = make(map[string]*discoveryEntry)
	r.discoveryByConn = make(map[*websocket.Conn]*discoveryEntry)
	r.invites = make(map[string]*inviteEntry)
	r.signalLimiters = make(map[*websocket.Conn]*tokenBucket)
}

// tokenBucket implements a simple token bucket rate limiter.
type tokenBucket struct {
	mu     sync.Mutex
	tokens int
	max    int
	ticker *time.Ticker
	done   chan struct{}
}

func newTokenBucket(rate int) *tokenBucket {
	return newIntervalTokenBucket(rate, time.Second)
}

func newIntervalTokenBucket(rate int, interval time.Duration) *tokenBucket {
	tb := &tokenBucket{
		tokens: rate,
		max:    rate,
		ticker: time.NewTicker(interval),
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

func copyRawMessage(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return nil
	}
	copied := make([]byte, len(value))
	copy(copied, value)
	return json.RawMessage(copied)
}
