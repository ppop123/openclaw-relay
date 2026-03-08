package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
)

const (
	maxDiscoveryMetadataBytes = 4096
	defaultInviteTTLSeconds   = 300
)

// DiscoveryPeer is the discoverable peer record returned by DISCOVER.
type DiscoveryPeer struct {
	PublicKey   string          `json:"public_key"`
	Metadata    json.RawMessage `json:"metadata,omitempty"`
	OnlineSince string          `json:"online_since"`
}

// Frame is the top-level JSON envelope for all WebSocket messages.
type Frame struct {
	Type string `json:"type"`

	// REGISTER / JOIN / DATA
	Channel string `json:"channel,omitempty"`
	Version int    `json:"version,omitempty"`

	// REGISTER discovery extension
	Discoverable bool            `json:"discoverable,omitempty"`
	PublicKey    string          `json:"public_key,omitempty"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`

	// JOIN
	ClientID string `json:"client_id,omitempty"`

	// DISCOVER / SIGNAL / INVITE
	Peers        []DiscoveryPeer `json:"peers,omitempty"`
	Target       string          `json:"target,omitempty"`
	Source       string          `json:"source,omitempty"`
	EphemeralKey string          `json:"ephemeral_key,omitempty"`
	InviteHash   string          `json:"invite_hash,omitempty"`
	MaxUses      int             `json:"max_uses,omitempty"`
	TTLSeconds   int             `json:"ttl_seconds,omitempty"`
	ExpiresAt    string          `json:"expires_at,omitempty"`

	// DATA
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Payload string `json:"payload,omitempty"`

	// PRESENCE
	Role   string `json:"role,omitempty"`
	Status string `json:"status,omitempty"`

	// PING / PONG
	Ts int64 `json:"ts,omitempty"`

	// ERROR / SIGNAL_ERROR
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`

	// REGISTERED response
	Clients int `json:"clients,omitempty"`

	// JOINED response
	GatewayOnline *bool `json:"gateway_online,omitempty"`
}

var channelHashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// base64DecodedLen estimates the decoded byte count for a base64-encoded
// string without actually decoding it.
func base64DecodedLen(s string) int {
	n := len(s)
	for n > 0 && s[n-1] == '=' {
		n--
	}
	return n * 3 / 4
}

func normalize32ByteBase64(value string) (string, bool) {
	if value == "" {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(value)
		if err != nil {
			return "", false
		}
	}
	if len(decoded) != 32 {
		return "", false
	}
	return base64.StdEncoding.EncodeToString(decoded), true
}

func normalizeMetadata(raw json.RawMessage) (json.RawMessage, string) {
	if len(raw) == 0 {
		return nil, ""
	}
	if len(raw) > maxDiscoveryMetadataBytes {
		return nil, "metadata_too_large"
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "invalid_frame"
	}
	if _, ok := parsed.(map[string]any); !ok {
		return nil, "invalid_frame"
	}
	normalized, err := json.Marshal(parsed)
	if err != nil {
		return nil, "invalid_frame"
	}
	if len(normalized) > maxDiscoveryMetadataBytes {
		return nil, "metadata_too_large"
	}
	return json.RawMessage(normalized), ""
}

func writeError(conn *websocket.Conn, code, message string) {
	writeJSON(conn, Frame{Type: "error", Code: code, Message: message})
}

func writeSignalError(conn *websocket.Conn, code, target string) {
	writeJSON(conn, Frame{Type: "signal_error", Code: code, Target: target})
}

// handleConnection is the main loop for a single WebSocket connection.
// The first message determines the role (gateway via "register", client via "join").
func handleConnection(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger) {
	defer conn.Close(websocket.StatusNormalClosure, "")

	frame, err := readFrame(ctx, conn)
	if err != nil {
		logger.Debug("failed to read initial frame", "error", err)
		return
	}

	if frame.Version != 0 && frame.Version != 1 {
		writeError(conn, "invalid_frame", fmt.Sprintf("unsupported protocol version: %d", frame.Version))
		return
	}

	switch frame.Type {
	case "register":
		handleGateway(ctx, conn, relay, logger, frame)
	case "join":
		handleClient(ctx, conn, relay, logger, frame)
	default:
		writeError(conn, "invalid_frame", "first message must be 'register' or 'join'")
	}
}

// handleGateway manages the lifecycle of a gateway connection.
func handleGateway(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger, initial Frame) {
	if !channelHashRe.MatchString(initial.Channel) {
		writeError(conn, "invalid_frame", "channel must be a 64-char lowercase hex string")
		return
	}

	if !initial.Discoverable && (initial.PublicKey != "" || len(initial.Metadata) > 0) {
		writeError(conn, "invalid_frame", "public_key and metadata require discoverable=true")
		return
	}

	if initial.Discoverable {
		if initial.PublicKey == "" {
			writeError(conn, "public_key_required", "public_key is required when discoverable=true")
			return
		}
		normalizedKey, ok := normalize32ByteBase64(initial.PublicKey)
		if !ok {
			writeError(conn, "invalid_public_key", "public_key must be a base64-encoded 32-byte X25519 public key")
			return
		}
		initial.PublicKey = normalizedKey

		normalizedMetadata, code := normalizeMetadata(initial.Metadata)
		if code != "" {
			message := "metadata must be a JSON object"
			if code == "metadata_too_large" {
				message = "metadata exceeds maximum size"
			}
			writeError(conn, code, message)
			return
		}
		initial.Metadata = normalizedMetadata
	}

	ch, errCode := relay.RegisterGateway(initial.Channel, conn)
	if errCode != "" {
		writeError(conn, errCode, fmt.Sprintf("registration failed: %s", errCode))
		return
	}
	defer relay.RemoveGateway(initial.Channel, conn)

	if initial.Discoverable {
		relay.BindGatewayDiscovery(initial.Channel, conn, initial.PublicKey, initial.Metadata)
	}

	writeJSON(conn, Frame{
		Type:    "registered",
		Channel: initial.Channel,
		Clients: relay.ClientCount(initial.Channel),
	})

	ch.mu.RLock()
	clients := make([]*clientConn, 0, len(ch.clients))
	for _, c := range ch.clients {
		clients = append(clients, c)
	}
	ch.mu.RUnlock()

	presenceOnline := Frame{Type: "presence", Role: "gateway", Status: "online"}
	for _, c := range clients {
		writeJSON(c.conn, presenceOnline)
	}

	for {
		frame, err := readFrame(ctx, conn)
		if err != nil {
			return
		}
		handleGatewayFrame(ctx, conn, relay, logger, ch, frame)
	}
}

// handleGatewayFrame processes a single frame from the gateway.
func handleGatewayFrame(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger, ch *channel, frame Frame) {
	switch frame.Type {
	case "data":
		if base64DecodedLen(frame.Payload) > relay.config.MaxPayload {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.oversized",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "gateway",
				"payload_bytes", base64DecodedLen(frame.Payload),
			)
			writeError(conn, "payload_too_large", "payload exceeds maximum size")
			return
		}
		if !ch.limiter.allow() {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.rate_limited",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "gateway",
			)
			writeError(conn, "rate_limited", "rate limit exceeded")
			return
		}
		if frame.To == "" {
			writeError(conn, "invalid_frame", "data frame must specify 'to' field")
			return
		}

		ch.mu.RLock()
		client, exists := ch.clients[frame.To]
		ch.mu.RUnlock()
		if exists {
			outFrame := Frame{Type: "data", From: "gateway", To: frame.To, Payload: frame.Payload}
			writeJSON(client.conn, outFrame)
			atomic.AddInt64(&relay.framesForwarded, 1)
		}

	case "discover":
		peers := relay.ListDiscoverablePeers(conn)
		writeJSON(conn, Frame{Type: "discover_result", Peers: peers})

	case "signal":
		sender, ok := relay.DiscoveryIdentityForConn(conn)
		if !ok {
			writeSignalError(conn, "not_discoverable", "")
			return
		}
		if frame.Target == "" || frame.Payload == "" || frame.EphemeralKey == "" {
			writeError(conn, "invalid_frame", "signal requires target, ephemeral_key, and payload")
			return
		}
		normalizedTarget, ok := normalize32ByteBase64(frame.Target)
		if !ok {
			writeError(conn, "invalid_public_key", "target must be a base64-encoded 32-byte X25519 public key")
			return
		}
		normalizedEphemeral, ok := normalize32ByteBase64(frame.EphemeralKey)
		if !ok {
			writeError(conn, "invalid_public_key", "ephemeral_key must be a base64-encoded 32-byte X25519 public key")
			return
		}
		if !relay.AllowSignal(conn) {
			atomic.AddInt64(&relay.framesRejected, 1)
			writeSignalError(conn, "rate_limited", normalizedTarget)
			return
		}
		target, ok := relay.LookupDiscoveryTarget(normalizedTarget)
		if !ok {
			writeSignalError(conn, "peer_offline", normalizedTarget)
			return
		}
		writeJSON(target.conn, Frame{
			Type:         "signal",
			Source:       sender.publicKey,
			EphemeralKey: normalizedEphemeral,
			Payload:      frame.Payload,
		})
		atomic.AddInt64(&relay.framesForwarded, 1)

	case "invite_create":
		if !channelHashRe.MatchString(frame.InviteHash) {
			writeError(conn, "invalid_frame", "invite_hash must be a 64-char lowercase hex string")
			return
		}
		if frame.MaxUses == 0 {
			frame.MaxUses = 1
		}
		if frame.MaxUses != 1 {
			writeError(conn, "invalid_frame", "max_uses must be 1 in the MVP")
			return
		}
		if frame.TTLSeconds == 0 {
			frame.TTLSeconds = defaultInviteTTLSeconds
		}
		if frame.TTLSeconds < 1 {
			writeError(conn, "invalid_frame", "ttl_seconds must be positive")
			return
		}
		expiresAt, errCode := relay.CreateInvite(conn, frame.InviteHash, frame.MaxUses, frame.TTLSeconds)
		if errCode != "" {
			writeError(conn, errCode, fmt.Sprintf("invite creation failed: %s", errCode))
			return
		}
		writeJSON(conn, Frame{
			Type:       "invite_created",
			InviteHash: frame.InviteHash,
			ExpiresAt:  expiresAt.Format(time.RFC3339),
		})

	case "ping":
		writeJSON(conn, Frame{Type: "pong", Ts: frame.Ts})

	default:
		writeError(conn, "invalid_frame", fmt.Sprintf("unexpected frame type from gateway: %s", frame.Type))
	}
}

// handleClient manages the lifecycle of a client connection.
func handleClient(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger, initial Frame) {
	if !channelHashRe.MatchString(initial.Channel) {
		writeError(conn, "invalid_frame", "channel must be a 64-char lowercase hex string")
		return
	}
	if initial.ClientID == "" {
		writeError(conn, "client_id_required", "client_id is required")
		return
	}

	ch, gatewayOnline, errCode := relay.JoinClient(initial.Channel, initial.ClientID, conn)
	if errCode != "" {
		writeError(conn, errCode, fmt.Sprintf("join failed: %s", errCode))
		return
	}

	writeJSON(conn, Frame{
		Type:          "joined",
		Channel:       initial.Channel,
		GatewayOnline: boolPtr(gatewayOnline),
	})

	ch.mu.RLock()
	gw := ch.gateway
	ch.mu.RUnlock()
	if gw != nil {
		writeJSON(gw, Frame{Type: "presence", Role: "client", Status: "online", ClientID: initial.ClientID})
	}

	defer relay.RemoveClient(ch.hash, initial.ClientID, conn, "disconnected")

	for {
		frame, err := readFrame(ctx, conn)
		if err != nil {
			return
		}
		handleClientFrame(ctx, conn, relay, logger, ch, initial.ClientID, frame)
	}
}

// handleClientFrame processes a single frame from a client.
func handleClientFrame(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger, ch *channel, clientID string, frame Frame) {
	switch frame.Type {
	case "data":
		if base64DecodedLen(frame.Payload) > relay.config.MaxPayload {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.oversized",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "client",
				"payload_bytes", base64DecodedLen(frame.Payload),
			)
			writeError(conn, "payload_too_large", "payload exceeds maximum size")
			return
		}
		if !ch.limiter.allow() {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.rate_limited",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "client",
			)
			writeError(conn, "rate_limited", "rate limit exceeded")
			return
		}

		ch.mu.RLock()
		gw := ch.gateway
		ch.mu.RUnlock()
		if gw != nil {
			outFrame := Frame{Type: "data", From: clientID, To: "gateway", Payload: frame.Payload}
			writeJSON(gw, outFrame)
			atomic.AddInt64(&relay.framesForwarded, 1)
		}

	case "discover", "signal", "invite_create":
		writeError(conn, "gateway_only", fmt.Sprintf("%s is only available to registered gateway connections", frame.Type))

	case "ping":
		writeJSON(conn, Frame{Type: "pong", Ts: frame.Ts})

	default:
		writeError(conn, "invalid_frame", fmt.Sprintf("unexpected frame type from client: %s", frame.Type))
	}
}

// readFrame reads and parses a single JSON frame from the WebSocket.
func readFrame(ctx context.Context, conn *websocket.Conn) (Frame, error) {
	readCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	_, data, err := conn.Read(readCtx)
	if err != nil {
		return Frame{}, err
	}

	var frame Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		writeError(conn, "invalid_frame", "malformed JSON")
		return Frame{}, fmt.Errorf("invalid JSON: %w", err)
	}
	return frame, nil
}

// writeJSON marshals a frame to JSON and writes it to the WebSocket.
func writeJSON(conn *websocket.Conn, frame Frame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

func boolPtr(b bool) *bool {
	return &b
}
