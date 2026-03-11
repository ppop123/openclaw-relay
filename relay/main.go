package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
	"nhooyr.io/websocket"
)

const version = "0.5.1"

func main() {
	var (
		port               int
		tlsMode            string
		certPath           string
		keyPath            string
		domain             string
		maxChannels        int
		maxClientsPerCh    int
		rateLimit          int
		maxPayload         int
		public             bool
		logFormat          string
		allowOrigins       string
		clientDir          string
	)

	flag.IntVar(&port, "port", 8443, "Listen port")
	flag.StringVar(&tlsMode, "tls", "off", "TLS mode: off, auto, manual")
	flag.StringVar(&certPath, "cert", "", "TLS cert path (when --tls manual)")
	flag.StringVar(&keyPath, "key", "", "TLS key path (when --tls manual)")
	flag.StringVar(&domain, "domain", "", "Domain for ACME TLS")
	flag.IntVar(&maxChannels, "max-channels", 500, "Max concurrent channels")
	flag.IntVar(&maxClientsPerCh, "max-clients-per-channel", 10, "Max clients per channel")
	flag.IntVar(&rateLimit, "rate-limit", 100, "Messages/second per channel")
	flag.IntVar(&maxPayload, "max-payload", 1048576, "Max payload bytes (1MB)")
	flag.BoolVar(&public, "public", false, "Advertise as public relay")
	flag.StringVar(&logFormat, "log-format", "text", "Log format: text or json")
	flag.StringVar(&allowOrigins, "allow-origin", "", "Comma-separated allowed origin hosts (e.g. myapp.com,*.example.com)")
	flag.StringVar(&clientDir, "client-dir", "", "Directory containing the web client assets to serve at /client/")
	flag.Parse()

	// Parse --allow-origin into origin patterns for WebSocket handshake.
	// When empty, only same-origin and non-browser (no Origin header) requests
	// are accepted. This is the secure default.
	var originPatterns []string
	if allowOrigins != "" {
		for _, o := range strings.Split(allowOrigins, ",") {
			o = strings.TrimSpace(o)
			if o != "" {
				originPatterns = append(originPatterns, o)
			}
		}
	}

	// Configure structured logging.
	var handler slog.Handler
	if logFormat == "json" {
		handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	} else {
		handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	}
	logger := slog.New(handler)

	relay := NewRelay(RelayConfig{
		MaxChannels:     maxChannels,
		MaxClientsPerCh: maxClientsPerCh,
		RateLimit:       rateLimit,
		MaxPayload:      maxPayload,
		Public:          public,
	}, logger)

	startTime := time.Now()

	mux := http.NewServeMux()

	// Optional: serve the web client assets (for non-technical users).
	// This keeps onboarding to a single clickable link: open it and connect.
	if clientDir == "" {
		clientDir = detectClientDir()
	}
	if clientDir == "" {
		logger.Info("webclient.disabled", "reason", "client directory not found; use --client-dir to specify")
	} else {
		clientDir = filepath.Clean(clientDir)
		logger.Info("webclient.enabled", "client_dir", clientDir)
		fileServer := http.FileServer(http.Dir(clientDir))
		mux.Handle("/client/", http.StripPrefix("/client/", noDirectoryListing(fileServer)))
		mux.HandleFunc("/client", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/client/", http.StatusMovedPermanently)
		})
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			http.Redirect(w, r, "/client/", http.StatusMovedPermanently)
		})
	}

	// WebSocket endpoint.
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: originPatterns,
		})
		if err != nil {
			logger.Error("websocket accept failed", "error", err)
			return
		}
		conn.SetReadLimit(int64(maxPayload)*4/3 + 4096) // base64-inflated payload + frame overhead
		handleConnection(r.Context(), conn, relay, logger)
	})

	// Status endpoint.
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		status := map[string]any{
			"name":                  "openclaw-relay",
			"version":              version,
			"protocol_version":     1,
			"channels_active":      relay.ChannelCount(),
			"channels_limit":       maxChannels,
			"connections_total":     relay.ConnectionCount(),
			"frames_forwarded_total": atomic.LoadInt64(&relay.framesForwarded),
			"frames_rejected_total":  atomic.LoadInt64(&relay.framesRejected),
			"uptime_seconds":       int(time.Since(startTime).Seconds()),
			"public":               public,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
	})

	listenAddr := fmt.Sprintf(":%d", port)

	server := &http.Server{
		Addr:         listenAddr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown on SIGTERM/SIGINT.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		<-ctx.Done()
		logger.Info("shutting down relay server")
		relay.CloseAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	logger.Info("relay.started",
		"listen_addr", listenAddr,
		"tls_mode", tlsMode,
		"max_channels", maxChannels,
	)

	var err error
	switch tlsMode {
	case "auto":
		if domain == "" {
			logger.Error("--domain is required when --tls auto")
			os.Exit(1)
		}
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(domain),
			Cache:      autocert.DirCache("autocert-cache"),
		}
		server.TLSConfig = &tls.Config{GetCertificate: m.GetCertificate}
		// Listen on port 80 for ACME HTTP-01 challenges.
		go http.ListenAndServe(":80", m.HTTPHandler(nil))
		ln, listenErr := net.Listen("tcp", listenAddr)
		if listenErr != nil {
			logger.Error("listen failed", "error", listenErr)
			os.Exit(1)
		}
		tlsLn := tls.NewListener(ln, server.TLSConfig)
		err = server.Serve(tlsLn)

	case "manual":
		if certPath == "" || keyPath == "" {
			logger.Error("--cert and --key are required when --tls manual")
			os.Exit(1)
		}
		err = server.ListenAndServeTLS(certPath, keyPath)

	default:
		err = server.ListenAndServe()
	}

	if err != nil && err != http.ErrServerClosed {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}

// noDirectoryListing wraps a file server handler to return 404 for subdirectory
// paths (e.g. /js/, /css/) instead of rendering a browsable file listing.
// The root path ("/") is allowed through so index.html is served.
func noDirectoryListing(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func detectClientDir() string {
	// Try common layouts:
	// - Running from repo root: ./client
	// - Running from ./relay directory: ../client
	// - Deployed alongside assets: ./client
	candidates := []string{
		"client",
		filepath.Join("..", "client"),
	}
	for _, candidate := range candidates {
		indexPath := filepath.Join(candidate, "index.html")
		if stat, err := os.Stat(indexPath); err == nil && !stat.IsDir() {
			return candidate
		}
	}
	return ""
}
