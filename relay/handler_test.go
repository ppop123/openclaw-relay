package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// Use a known channel hash for testing (64 hex chars).
const testChannelHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// helper: create a test relay server with default (secure) origin policy.
func setupTestRelay(t *testing.T, config RelayConfig) *httptest.Server {
	t.Helper()
	return setupTestRelayWithOrigins(t, config, nil)
}

// helper: create a test relay server with specific origin patterns.
func setupTestRelayWithOrigins(t *testing.T, config RelayConfig, originPatterns []string) *httptest.Server {
	t.Helper()
	logger := slog.Default()
	relay := NewRelay(config, logger)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: originPatterns,
		})
		if err != nil {
			// Not a test failure — expected for origin-rejected tests.
			return
		}
		if config.MaxPayload > 0 {
			conn.SetReadLimit(int64(config.MaxPayload)*4/3 + 4096)
		}
		handleConnection(r.Context(), conn, relay, logger)
	})

	return httptest.NewServer(mux)
}

// helper: connect a WebSocket client.
func wsConnect(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(url, "http://", "ws://", 1) + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	return conn
}

// helper: send a JSON frame.
func sendTestFrame(t *testing.T, conn *websocket.Conn, frame Frame) {
	t.Helper()
	data, _ := json.Marshal(frame)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write failed: %v", err)
	}
}

// helper: read a JSON frame with a default 5s timeout.
func readTestFrame(t *testing.T, conn *websocket.Conn) Frame {
	t.Helper()
	return readTestFrameTimeout(t, conn, 5*time.Second)
}

// helper: read a JSON frame with a custom timeout.
func readTestFrameTimeout(t *testing.T, conn *websocket.Conn, timeout time.Duration) Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	var frame Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	return frame
}

// helper: register a gateway on a test server and return the connection.
func registerGateway(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn := wsConnect(t, url)
	sendTestFrame(t, conn, Frame{Type: "register", Channel: testChannelHash})
	f := readTestFrame(t, conn)
	if f.Type != "registered" {
		t.Fatalf("expected registered, got %s (code=%s msg=%s)", f.Type, f.Code, f.Message)
	}
	return conn
}

// helper: join a client on a test server and return the connection.
func joinClient(t *testing.T, url, clientID string) *websocket.Conn {
	t.Helper()
	conn := wsConnect(t, url)
	sendTestFrame(t, conn, Frame{Type: "join", Channel: testChannelHash, ClientID: clientID})
	f := readTestFrame(t, conn)
	if f.Type != "joined" {
		t.Fatalf("expected joined, got %s (code=%s msg=%s)", f.Type, f.Code, f.Message)
	}
	return conn
}

func TestBase64DecodedLen(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  int
	}{
		{"Hello with padding", "SGVsbG8=", 5},
		{"Hello without padding", "SGVsbG8", 5},
		{"empty string", "", 0},
		{"double padding", "YWI=", 2},    // "ab"
		{"no padding needed", "AQID", 3}, // 3 bytes
		{"single char", "YQ==", 1},       // "a"
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := base64DecodedLen(tc.input)
			if got != tc.want {
				t.Errorf("base64DecodedLen(%q) = %d, want %d", tc.input, got, tc.want)
			}
		})
	}

	// Cross-check against real base64 decoding for a variety of lengths.
	for i := 0; i < 100; i++ {
		raw := make([]byte, i)
		for j := range raw {
			raw[j] = byte(j)
		}
		encoded := base64.StdEncoding.EncodeToString(raw)
		got := base64DecodedLen(encoded)
		if got != i {
			t.Errorf("base64DecodedLen(encode(%d bytes)) = %d, want %d", i, got, i)
		}
	}
}

func TestGatewayRegister(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	conn := wsConnect(t, srv.URL)
	defer conn.Close(websocket.StatusNormalClosure, "")

	sendTestFrame(t, conn, Frame{Type: "register", Channel: testChannelHash})
	f := readTestFrame(t, conn)

	if f.Type != "registered" {
		t.Fatalf("expected type 'registered', got %q", f.Type)
	}
	if f.Channel != testChannelHash {
		t.Errorf("expected channel %s, got %s", testChannelHash, f.Channel)
	}
}

func TestClientJoin(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	// Register gateway first.
	gw := registerGateway(t, srv.URL)
	defer gw.Close(websocket.StatusNormalClosure, "")

	// Join client.
	client := wsConnect(t, srv.URL)
	defer client.Close(websocket.StatusNormalClosure, "")

	sendTestFrame(t, client, Frame{Type: "join", Channel: testChannelHash, ClientID: "c1"})
	f := readTestFrame(t, client)

	if f.Type != "joined" {
		t.Fatalf("expected type 'joined', got %q", f.Type)
	}
	if f.GatewayOnline == nil || !*f.GatewayOnline {
		t.Error("expected gateway_online = true")
	}

	// Gateway should get a presence notification.
	pf := readTestFrame(t, gw)
	if pf.Type != "presence" || pf.Role != "client" || pf.Status != "online" || pf.ClientID != "c1" {
		t.Errorf("unexpected presence frame: %+v", pf)
	}
}

func TestDataForwarding(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	gw := registerGateway(t, srv.URL)
	defer gw.Close(websocket.StatusNormalClosure, "")

	client := joinClient(t, srv.URL, "c1")
	defer client.Close(websocket.StatusNormalClosure, "")

	// Drain the presence notification on the gateway side.
	readTestFrame(t, gw) // presence: client online

	// Client -> Gateway.
	payload := base64.StdEncoding.EncodeToString([]byte("hello from client"))
	sendTestFrame(t, client, Frame{Type: "data", Payload: payload})
	f := readTestFrame(t, gw)
	if f.Type != "data" {
		t.Fatalf("expected data frame, got %s", f.Type)
	}
	if f.From != "c1" {
		t.Errorf("expected from='c1', got %q", f.From)
	}
	if f.Payload != payload {
		t.Errorf("payload mismatch: got %q, want %q", f.Payload, payload)
	}

	// Gateway -> Client.
	payload2 := base64.StdEncoding.EncodeToString([]byte("hello from gateway"))
	sendTestFrame(t, gw, Frame{Type: "data", To: "c1", Payload: payload2})
	f2 := readTestFrame(t, client)
	if f2.Type != "data" {
		t.Fatalf("expected data frame, got %s", f2.Type)
	}
	if f2.Payload != payload2 {
		t.Errorf("payload mismatch: got %q, want %q", f2.Payload, payload2)
	}
}

func TestPayloadTooLarge(t *testing.T) {
	maxPayload := 100 // 100 decoded bytes max
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      maxPayload,
	})
	defer srv.Close()

	gw := registerGateway(t, srv.URL)
	defer gw.Close(websocket.StatusNormalClosure, "")

	client := joinClient(t, srv.URL, "c1")
	defer client.Close(websocket.StatusNormalClosure, "")

	// Drain presence notification.
	readTestFrame(t, gw) // presence: client online

	// Create a payload whose decoded size exceeds maxPayload.
	bigData := make([]byte, maxPayload+1)
	for i := range bigData {
		bigData[i] = 'A'
	}
	bigPayload := base64.StdEncoding.EncodeToString(bigData)

	// Client sends oversized payload.
	sendTestFrame(t, client, Frame{Type: "data", Payload: bigPayload})
	f := readTestFrame(t, client)
	if f.Type != "error" || f.Code != "payload_too_large" {
		t.Errorf("expected payload_too_large error, got type=%s code=%s", f.Type, f.Code)
	}

	// Gateway sends oversized payload.
	sendTestFrame(t, gw, Frame{Type: "data", To: "c1", Payload: bigPayload})
	f2 := readTestFrame(t, gw)
	if f2.Type != "error" || f2.Code != "payload_too_large" {
		t.Errorf("expected payload_too_large error, got type=%s code=%s", f2.Type, f2.Code)
	}

	// A payload that fits within the decoded limit should succeed.
	okData := make([]byte, maxPayload)
	for i := range okData {
		okData[i] = 'B'
	}
	okPayload := base64.StdEncoding.EncodeToString(okData)

	sendTestFrame(t, client, Frame{Type: "data", Payload: okPayload})
	fOK := readTestFrame(t, gw)
	if fOK.Type != "data" {
		t.Errorf("expected data frame for within-limit payload, got type=%s code=%s", fOK.Type, fOK.Code)
	}
}

func TestDuplicateClientId(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	gw := registerGateway(t, srv.URL)
	defer gw.Close(websocket.StatusNormalClosure, "")

	// First client with id "c1".
	client1 := joinClient(t, srv.URL, "c1")
	readTestFrame(t, gw) // presence: c1 online

	// Second client with same id "c1" — should replace the first.
	// Use a longer timeout because JoinClient holds a lock while closing
	// the old connection (nhooyr.io/websocket Close waits up to 5s for
	// the close handshake).
	client2 := wsConnect(t, srv.URL)
	defer client2.Close(websocket.StatusNormalClosure, "")

	sendTestFrame(t, client2, Frame{Type: "join", Channel: testChannelHash, ClientID: "c1"})
	f := readTestFrameTimeout(t, client2, 10*time.Second)
	if f.Type != "joined" {
		t.Fatalf("expected joined, got %s (code=%s msg=%s)", f.Type, f.Code, f.Message)
	}

	// Read presence notification on gateway (c1 online again).
	pf := readTestFrameTimeout(t, gw, 10*time.Second)
	if pf.Type != "presence" || pf.ClientID != "c1" || pf.Status != "online" {
		t.Errorf("expected c1 online presence, got %+v", pf)
	}

	// The old client1 should have been closed by the server.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, _, err := client1.Read(ctx)
	if err == nil {
		t.Error("expected client1 read to fail after replacement")
	}

	// Send data from gateway to "c1" — should arrive at client2.
	payload := base64.StdEncoding.EncodeToString([]byte("for new c1"))
	sendTestFrame(t, gw, Frame{Type: "data", To: "c1", Payload: payload})
	f2 := readTestFrame(t, client2)
	if f2.Type != "data" || f2.Payload != payload {
		t.Errorf("expected data on client2, got type=%s payload=%s", f2.Type, f2.Payload)
	}
}

func TestOriginNoHeader(t *testing.T) {
	// Non-browser clients (no Origin header) should always be accepted.
	srv := setupTestRelayWithOrigins(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	}, []string{"allowed.example.com"})
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/ws"

	// Dial without any Origin header.
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("expected connection without Origin to succeed, got: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Verify we can actually register (connection is functional).
	sendTestFrame(t, conn, Frame{Type: "register", Channel: testChannelHash})
	f := readTestFrame(t, conn)
	if f.Type != "registered" {
		t.Fatalf("expected registered, got %s (code=%s msg=%s)", f.Type, f.Code, f.Message)
	}
}

func TestOriginAllowed(t *testing.T) {
	// Whitelisted Origin should be accepted.
	srv := setupTestRelayWithOrigins(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	}, []string{"allowed.example.com"})
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/ws"

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Origin": []string{"https://allowed.example.com"},
		},
	})
	if err != nil {
		t.Fatalf("expected whitelisted Origin to succeed, got: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	sendTestFrame(t, conn, Frame{Type: "register", Channel: testChannelHash})
	f := readTestFrame(t, conn)
	if f.Type != "registered" {
		t.Fatalf("expected registered, got %s (code=%s msg=%s)", f.Type, f.Code, f.Message)
	}
}

func TestOriginRejected(t *testing.T) {
	// Non-whitelisted Origin should be rejected.
	srv := setupTestRelayWithOrigins(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	}, []string{"allowed.example.com"})
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/ws"

	_, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Origin": []string{"https://evil.example.com"},
		},
	})
	if err == nil {
		t.Fatal("expected non-whitelisted Origin to be rejected, but connection succeeded")
	}
	// The error should indicate a 403 Forbidden from the server.
	if !strings.Contains(err.Error(), "403") {
		t.Logf("connection rejected (expected), error: %v", err)
	}
}

func TestPresenceNotifications(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	// Client joins first (no gateway).
	client := joinClient(t, srv.URL, "c1")
	defer client.Close(websocket.StatusNormalClosure, "")

	// Gateway registers — client should get gateway online presence.
	gw := registerGateway(t, srv.URL)

	// Client should receive gateway online presence.
	pf := readTestFrame(t, client)
	if pf.Type != "presence" || pf.Role != "gateway" || pf.Status != "online" {
		t.Errorf("expected gateway online presence, got %+v", pf)
	}

	// Gateway should have gotten a presence notification about the existing client
	// during registration (the "registered" response was already consumed in registerGateway).
	// This actually comes through the handleGateway loop, not from a separate message.

	// Close gateway — client should get gateway offline presence.
	gw.Close(websocket.StatusNormalClosure, "bye")

	pf2 := readTestFrame(t, client)
	if pf2.Type != "presence" || pf2.Role != "gateway" || pf2.Status != "offline" {
		t.Errorf("expected gateway offline presence, got %+v", pf2)
	}
}

func testKeyB64(fill byte) string {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = fill
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func registerGatewayWithFrame(t *testing.T, url string, frame Frame) *websocket.Conn {
	t.Helper()
	conn := wsConnect(t, url)
	sendTestFrame(t, conn, frame)
	f := readTestFrame(t, conn)
	if f.Type != "registered" {
		t.Fatalf("expected registered, got %s (code=%s msg=%s)", f.Type, f.Code, f.Message)
	}
	return conn
}

func TestDiscoverGatewayOnly(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	keyA := testKeyB64(0x11)
	keyB := testKeyB64(0x22)
	channelB := strings.Repeat("b", 64)

	gwA := registerGatewayWithFrame(t, srv.URL, Frame{
		Type:         "register",
		Channel:      testChannelHash,
		Discoverable: true,
		PublicKey:    keyA,
		Metadata:     json.RawMessage(`{"name":"alpha"}`),
	})
	defer gwA.Close(websocket.StatusNormalClosure, "")

	gwB := registerGatewayWithFrame(t, srv.URL, Frame{
		Type:         "register",
		Channel:      channelB,
		Discoverable: true,
		PublicKey:    keyB,
		Metadata:     json.RawMessage(`{"name":"beta"}`),
	})
	defer gwB.Close(websocket.StatusNormalClosure, "")

	hidden := registerGatewayWithFrame(t, srv.URL, Frame{Type: "register", Channel: strings.Repeat("c", 64)})
	defer hidden.Close(websocket.StatusNormalClosure, "")

	sendTestFrame(t, hidden, Frame{Type: "discover"})
	hiddenResult := readTestFrame(t, hidden)
	if hiddenResult.Type != "discover_result" {
		t.Fatalf("expected discover_result for non-discoverable gateway, got %s (code=%s msg=%s)", hiddenResult.Type, hiddenResult.Code, hiddenResult.Message)
	}
	if len(hiddenResult.Peers) != 2 {
		t.Fatalf("expected 2 discovered peers for hidden gateway, got %d", len(hiddenResult.Peers))
	}

	sendTestFrame(t, gwA, Frame{Type: "discover"})
	result := readTestFrame(t, gwA)
	if result.Type != "discover_result" {
		t.Fatalf("expected discover_result, got %s (code=%s msg=%s)", result.Type, result.Code, result.Message)
	}
	if len(result.Peers) != 1 {
		t.Fatalf("expected 1 discovered peer, got %d", len(result.Peers))
	}
	if result.Peers[0].PublicKey != keyB {
		t.Fatalf("expected peer public key %s, got %s", keyB, result.Peers[0].PublicKey)
	}
	if strings.Contains(string(result.Peers[0].Metadata), testChannelHash) || strings.Contains(string(result.Peers[0].Metadata), channelB) {
		t.Fatal("discover_result metadata should not leak channel hashes")
	}

	client := joinClient(t, srv.URL, "human-1")
	defer client.Close(websocket.StatusNormalClosure, "")
	readTestFrame(t, gwA) // presence: human-1 online

	sendTestFrame(t, client, Frame{Type: "discover"})
	errFrame := readTestFrame(t, client)
	if errFrame.Type != "error" || errFrame.Code != "gateway_only" {
		t.Fatalf("expected gateway_only error, got type=%s code=%s msg=%s", errFrame.Type, errFrame.Code, errFrame.Message)
	}
}

func TestRegisterDiscoverableValidation(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	t.Run("invalid public key", func(t *testing.T) {
		conn := wsConnect(t, srv.URL)
		defer conn.Close(websocket.StatusNormalClosure, "")
		sendTestFrame(t, conn, Frame{Type: "register", Channel: testChannelHash, Discoverable: true, PublicKey: "bad-key"})
		frame := readTestFrame(t, conn)
		if frame.Type != "error" || frame.Code != "invalid_public_key" {
			t.Fatalf("expected invalid_public_key, got type=%s code=%s msg=%s", frame.Type, frame.Code, frame.Message)
		}
	})

	t.Run("non-discoverable cannot send metadata", func(t *testing.T) {
		conn := wsConnect(t, srv.URL)
		defer conn.Close(websocket.StatusNormalClosure, "")
		sendTestFrame(t, conn, Frame{Type: "register", Channel: strings.Repeat("e", 64), Metadata: json.RawMessage(`{"name":"oops"}`)})
		frame := readTestFrame(t, conn)
		if frame.Type != "error" || frame.Code != "invalid_frame" {
			t.Fatalf("expected invalid_frame, got type=%s code=%s msg=%s", frame.Type, frame.Code, frame.Message)
		}
	})
}

func TestSignalForwardingAndSenderRestriction(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	keyA := testKeyB64(0x31)
	keyB := testKeyB64(0x32)
	ephemeralKey := testKeyB64(0x7f)
	channelB := strings.Repeat("b", 64)
	channelC := strings.Repeat("c", 64)

	gwA := registerGatewayWithFrame(t, srv.URL, Frame{
		Type:         "register",
		Channel:      testChannelHash,
		Discoverable: true,
		PublicKey:    keyA,
		Metadata:     json.RawMessage(`{"name":"alpha"}`),
	})
	defer gwA.Close(websocket.StatusNormalClosure, "")

	gwB := registerGatewayWithFrame(t, srv.URL, Frame{
		Type:         "register",
		Channel:      channelB,
		Discoverable: true,
		PublicKey:    keyB,
		Metadata:     json.RawMessage(`{"name":"beta"}`),
	})
	defer gwB.Close(websocket.StatusNormalClosure, "")

	payload := base64.StdEncoding.EncodeToString([]byte("opaque-ciphertext"))
	sendTestFrame(t, gwA, Frame{Type: "signal", Target: keyB, EphemeralKey: ephemeralKey, Payload: payload})
	forwarded := readTestFrame(t, gwB)
	if forwarded.Type != "signal" {
		t.Fatalf("expected forwarded signal, got %s (code=%s msg=%s)", forwarded.Type, forwarded.Code, forwarded.Message)
	}
	if forwarded.Source != keyA {
		t.Fatalf("expected source %s, got %s", keyA, forwarded.Source)
	}
	if forwarded.Payload != payload {
		t.Fatalf("expected payload %s, got %s", payload, forwarded.Payload)
	}
	if forwarded.EphemeralKey != ephemeralKey {
		t.Fatalf("expected ephemeral key %s, got %s", ephemeralKey, forwarded.EphemeralKey)
	}

	nonDiscoverable := registerGatewayWithFrame(t, srv.URL, Frame{Type: "register", Channel: channelC})
	defer nonDiscoverable.Close(websocket.StatusNormalClosure, "")
	sendTestFrame(t, nonDiscoverable, Frame{Type: "signal", Target: keyB, EphemeralKey: ephemeralKey, Payload: payload})
	errFrame := readTestFrame(t, nonDiscoverable)
	if errFrame.Type != "signal_error" || errFrame.Code != "not_discoverable" {
		t.Fatalf("expected signal_error/not_discoverable, got type=%s code=%s msg=%s", errFrame.Type, errFrame.Code, errFrame.Message)
	}
}

func TestInviteAliasJoin(t *testing.T) {
	srv := setupTestRelay(t, RelayConfig{
		MaxChannels:     10,
		MaxClientsPerCh: 5,
		RateLimit:       100,
		MaxPayload:      1024,
	})
	defer srv.Close()

	keyB := testKeyB64(0x52)
	channelB := strings.Repeat("b", 64)
	inviteHash := strings.Repeat("d", 64)

	gwB := registerGatewayWithFrame(t, srv.URL, Frame{
		Type:         "register",
		Channel:      channelB,
		Discoverable: true,
		PublicKey:    keyB,
		Metadata:     json.RawMessage(`{"name":"beta"}`),
	})
	defer gwB.Close(websocket.StatusNormalClosure, "")

	sendTestFrame(t, gwB, Frame{Type: "invite_create", InviteHash: inviteHash, MaxUses: 1, TTLSeconds: 300})
	created := readTestFrame(t, gwB)
	if created.Type != "invite_created" {
		t.Fatalf("expected invite_created, got %s (code=%s msg=%s)", created.Type, created.Code, created.Message)
	}
	if created.InviteHash != inviteHash {
		t.Fatalf("expected invite_hash %s, got %s", inviteHash, created.InviteHash)
	}
	if created.ExpiresAt == "" {
		t.Fatal("expected invite_created to include expires_at")
	}

	peer := wsConnect(t, srv.URL)
	defer peer.Close(websocket.StatusNormalClosure, "")
	sendTestFrame(t, peer, Frame{Type: "join", Channel: inviteHash, ClientID: "peer-a"})
	joined := readTestFrame(t, peer)
	if joined.Type != "joined" {
		t.Fatalf("expected joined, got %s (code=%s msg=%s)", joined.Type, joined.Code, joined.Message)
	}
	if joined.GatewayOnline == nil || !*joined.GatewayOnline {
		t.Fatal("expected gateway_online=true when joining through invite alias")
	}
	presence := readTestFrame(t, gwB)
	if presence.Type != "presence" || presence.ClientID != "peer-a" || presence.Status != "online" {
		t.Fatalf("expected peer-a online presence, got %+v", presence)
	}

	payload := base64.StdEncoding.EncodeToString([]byte("hello via invite"))
	sendTestFrame(t, gwB, Frame{Type: "data", To: "peer-a", Payload: payload})
	forwarded := readTestFrame(t, peer)
	if forwarded.Type != "data" || forwarded.Payload != payload {
		t.Fatalf("expected invited peer data forwarding, got type=%s payload=%s", forwarded.Type, forwarded.Payload)
	}

	peer2 := wsConnect(t, srv.URL)
	defer peer2.Close(websocket.StatusNormalClosure, "")
	sendTestFrame(t, peer2, Frame{Type: "join", Channel: inviteHash, ClientID: "peer-b"})
	joinErr := readTestFrame(t, peer2)
	if joinErr.Type != "error" || joinErr.Code != "invite_invalid" {
		t.Fatalf("expected invite_invalid on reused invite, got type=%s code=%s msg=%s", joinErr.Type, joinErr.Code, joinErr.Message)
	}
}
