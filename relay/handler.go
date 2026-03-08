package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
)

// Frame is the top-level JSON envelope for all WebSocket messages.
type Frame struct {
	Type    string `json:"type"`

	// REGISTER / JOIN / DATA
	Channel string `json:"channel,omitempty"`
	Version int    `json:"version,omitempty"`

	// JOIN
	ClientID string `json:"client_id,omitempty"`

	// DATA
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Payload string `json:"payload,omitempty"`

	// PRESENCE
	Role   string `json:"role,omitempty"`
	Status string `json:"status,omitempty"`

	// PING / PONG
	Ts int64 `json:"ts,omitempty"`

	// ERROR
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
	// Remove padding characters
	for n > 0 && s[n-1] == '=' {
		n--
	}
	return n * 3 / 4
}

// handleConnection is the main loop for a single WebSocket connection.
// The first message determines the role (gateway via "register", client via "join").
func handleConnection(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger) {
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Read the first frame to determine role.
	frame, err := readFrame(ctx, conn)
	if err != nil {
		logger.Debug("failed to read initial frame", "error", err)
		return
	}

	// Validate protocol version (0 means omitted, treat as v1).
	if frame.Version != 0 && frame.Version != 1 {
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: fmt.Sprintf("unsupported protocol version: %d", frame.Version),
		})
		return
	}

	switch frame.Type {
	case "register":
		handleGateway(ctx, conn, relay, logger, frame)
	case "join":
		handleClient(ctx, conn, relay, logger, frame)
	default:
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: "first message must be 'register' or 'join'",
		})
	}
}

// handleGateway manages the lifecycle of a gateway connection.
func handleGateway(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger, initial Frame) {
	if !channelHashRe.MatchString(initial.Channel) {
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: "channel must be a 64-char lowercase hex string",
		})
		return
	}

	ch, errCode := relay.RegisterGateway(initial.Channel, conn)
	if errCode != "" {
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    errCode,
			Message: fmt.Sprintf("registration failed: %s", errCode),
		})
		return
	}

	// Send registered acknowledgement.
	writeJSON(conn, Frame{
		Type:    "registered",
		Channel: initial.Channel,
		Clients: relay.ClientCount(initial.Channel),
	})

	// Notify existing clients that gateway came online.
	ch.mu.RLock()
	clients := make([]*clientConn, 0, len(ch.clients))
	for _, c := range ch.clients {
		clients = append(clients, c)
	}
	ch.mu.RUnlock()

	presenceOnline := Frame{
		Type:   "presence",
		Role:   "gateway",
		Status: "online",
	}
	for _, c := range clients {
		writeJSON(c.conn, presenceOnline)
	}

	defer relay.RemoveGateway(initial.Channel)

	// Read loop.
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
		// Validate payload size (use decoded byte count since payload is base64).
		if base64DecodedLen(frame.Payload) > relay.config.MaxPayload {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.oversized",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "gateway",
				"payload_bytes", base64DecodedLen(frame.Payload),
			)
			writeJSON(conn, Frame{
				Type:    "error",
				Code:    "payload_too_large",
				Message: "payload exceeds maximum size",
			})
			return
		}

		// Rate limit.
		if !ch.limiter.allow() {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.rate_limited",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "gateway",
			)
			writeJSON(conn, Frame{
				Type:    "error",
				Code:    "rate_limited",
				Message: "rate limit exceeded",
			})
			return
		}

		// Forward to specific client.
		if frame.To == "" {
			writeJSON(conn, Frame{
				Type:    "error",
				Code:    "invalid_frame",
				Message: "data frame must specify 'to' field",
			})
			return
		}

		ch.mu.RLock()
		client, exists := ch.clients[frame.To]
		ch.mu.RUnlock()

		if exists {
			outFrame := Frame{
				Type:    "data",
				From:    "gateway",
				To:      frame.To,
				Payload: frame.Payload,
			}
			writeJSON(client.conn, outFrame)
			atomic.AddInt64(&relay.framesForwarded, 1)
		}

	case "ping":
		writeJSON(conn, Frame{Type: "pong", Ts: frame.Ts})

	default:
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: fmt.Sprintf("unexpected frame type from gateway: %s", frame.Type),
		})
	}
}

// handleClient manages the lifecycle of a client connection.
func handleClient(ctx context.Context, conn *websocket.Conn, relay *Relay, logger *slog.Logger, initial Frame) {
	if !channelHashRe.MatchString(initial.Channel) {
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: "channel must be a 64-char lowercase hex string",
		})
		return
	}

	if initial.ClientID == "" {
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: "client_id is required",
		})
		return
	}

	ch, gatewayOnline, errCode := relay.JoinClient(initial.Channel, initial.ClientID, conn)
	if errCode != "" {
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    errCode,
			Message: fmt.Sprintf("join failed: %s", errCode),
		})
		return
	}

	// Send joined acknowledgement.
	writeJSON(conn, Frame{
		Type:          "joined",
		Channel:       initial.Channel,
		GatewayOnline: boolPtr(gatewayOnline),
	})

	// Notify gateway that client joined.
	ch.mu.RLock()
	gw := ch.gateway
	ch.mu.RUnlock()

	if gw != nil {
		writeJSON(gw, Frame{
			Type:     "presence",
			Role:     "client",
			Status:   "online",
			ClientID: initial.ClientID,
		})
	}

	defer relay.RemoveClient(initial.Channel, initial.ClientID, conn, "disconnected")

	// Read loop.
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
		// Validate payload size (use decoded byte count since payload is base64).
		if base64DecodedLen(frame.Payload) > relay.config.MaxPayload {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.oversized",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "client",
				"payload_bytes", base64DecodedLen(frame.Payload),
			)
			writeJSON(conn, Frame{
				Type:    "error",
				Code:    "payload_too_large",
				Message: "payload exceeds maximum size",
			})
			return
		}

		// Rate limit.
		if !ch.limiter.allow() {
			atomic.AddInt64(&relay.framesRejected, 1)
			logger.Info("frame.rate_limited",
				"channel_hash", ch.hash[:min(12, len(ch.hash))],
				"sender_role", "client",
			)
			writeJSON(conn, Frame{
				Type:    "error",
				Code:    "rate_limited",
				Message: "rate limit exceeded",
			})
			return
		}

		// Forward to gateway.
		ch.mu.RLock()
		gw := ch.gateway
		ch.mu.RUnlock()

		if gw != nil {
			outFrame := Frame{
				Type:    "data",
				From:    clientID,
				To:      "gateway",
				Payload: frame.Payload,
			}
			writeJSON(gw, outFrame)
			atomic.AddInt64(&relay.framesForwarded, 1)
		}

	case "ping":
		writeJSON(conn, Frame{Type: "pong", Ts: frame.Ts})

	default:
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: fmt.Sprintf("unexpected frame type from client: %s", frame.Type),
		})
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
		writeJSON(conn, Frame{
			Type:    "error",
			Code:    "invalid_frame",
			Message: "malformed JSON",
		})
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
