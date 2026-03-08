/**
 * RelayChannel — Durable Object (EXPERIMENTAL)
 *
 * One instance per channel. Holds WebSocket connections for the gateway
 * and up to N clients. Forwards DATA frames between them.
 *
 * Uses the WebSocket Hibernation API so idle connections don't consume CPU.
 *
 * NOTE: Unlike the Go relay which uses register/join frames after connection,
 * this implementation receives role and client_id via URL parameters at
 * connection time. The register/join frames are handled as in-band messages
 * to send acknowledgement responses (registered/joined) to clients.
 *
 * WebSocket tags:
 *   Gateway:  ["gateway"]
 *   Client:   ["client", "id:<client_id>"]
 */

import type { Env } from "./index";

interface Frame {
	type: string;
	channel?: string;
	version?: number;
	client_id?: string;
	from?: string;
	to?: string;
	payload?: string;
	ts?: number;
	[key: string]: unknown;
}

const MAX_CLIENTS = 10;
const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MB
const RATE_LIMIT_PER_SECOND = 100;

export class RelayChannel {
	private state: DurableObjectState;

	// Rate limiter state (reset each second)
	private msgCount = 0;
	private rateLimitResetAt = 0;

	constructor(state: DurableObjectState, _env: Env) {
		this.state = state;
	}

	/**
	 * HTTP fetch handler — accepts WebSocket upgrades.
	 */
	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get("Upgrade");
		if (upgradeHeader?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const url = new URL(request.url);
		const role = url.searchParams.get("role")!;
		const clientId = url.searchParams.get("id");

		// --- Gateway ---
		if (role === "gateway") {
			const existing = this.state.getWebSockets("gateway");
			if (existing.length > 0) {
				return new Response(
					JSON.stringify({ type: "error", code: "channel_occupied", message: "Another gateway is already registered" }),
					{ status: 409 },
				);
			}
			const pair = new WebSocketPair();
			this.state.acceptWebSocket(pair[1], ["gateway"]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}

		// --- Client ---
		if (role === "client" && clientId) {
			const clients = this.state.getWebSockets("client");
			if (clients.length >= MAX_CLIENTS) {
				return new Response(
					JSON.stringify({ type: "error", code: "channel_full", message: `Maximum ${MAX_CLIENTS} clients per channel` }),
					{ status: 409 },
				);
			}
			// Check for duplicate client_id
			const existing = this.state.getWebSockets(`id:${clientId}`);
			if (existing.length > 0) {
				// Close old connection, allow new one
				for (const ws of existing) {
					try {
						ws.close(1000, "Replaced by new connection");
					} catch {
						// ignore
					}
				}
			}
			const pair = new WebSocketPair();
			this.state.acceptWebSocket(pair[1], ["client", `id:${clientId}`]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}

		return new Response("Bad request", { status: 400 });
	}

	/**
	 * Called when a WebSocket message arrives (Hibernation API).
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") {
			this.sendError(ws, "invalid_frame", "Binary frames not supported");
			return;
		}

		// Rate limiting
		if (!this.checkRateLimit()) {
			this.sendError(ws, "rate_limited", "Too many messages, slow down");
			return;
		}

		let frame: Frame;
		try {
			frame = JSON.parse(message);
		} catch {
			this.sendError(ws, "invalid_frame", "Failed to parse JSON");
			return;
		}

		if (!frame.type) {
			this.sendError(ws, "invalid_frame", "Missing frame type");
			return;
		}

		const tags = this.state.getTags(ws);
		const isGateway = tags.includes("gateway");

		switch (frame.type) {
			case "register":
				this.handleRegister(ws, frame, isGateway);
				break;

			case "join":
				this.handleJoin(ws, frame, isGateway, tags);
				break;

			case "data":
				this.handleData(ws, frame, isGateway, tags, message);
				break;

			case "ping":
				ws.send(JSON.stringify({ type: "pong", ts: frame.ts }));
				break;

			default:
				// Silently ignore unknown frames (forward compat)
				break;
		}
	}

	/**
	 * Called when a WebSocket connection closes (Hibernation API).
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		const tags = this.state.getTags(ws);
		const isGateway = tags.includes("gateway");

		if (isGateway) {
			// Notify all clients that gateway went offline
			const clients = this.state.getWebSockets("client");
			const presence = JSON.stringify({ type: "presence", role: "gateway", status: "offline" });
			for (const client of clients) {
				this.safeSend(client, presence);
			}
		} else {
			// Find client_id from tags
			const clientId = this.extractClientId(tags);
			if (clientId) {
				// Ownership check: only send offline notification if no other
				// WebSocket currently owns this client_id. This prevents a
				// replaced (old) connection from sending spurious offline events.
				const currentConnections = this.state.getWebSockets(`id:${clientId}`);
				const stillActive = currentConnections.some(other => other !== ws);
				if (!stillActive) {
					// No other connection for this client_id — truly offline
					const gateways = this.state.getWebSockets("gateway");
					const presence = JSON.stringify({
						type: "presence",
						role: "client",
						client_id: clientId,
						status: "offline",
					});
					for (const gw of gateways) {
						this.safeSend(gw, presence);
					}
				}
			}
		}
	}

	/**
	 * Called on WebSocket error.
	 */
	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		// Just let it close naturally
	}

	// ----------------------------------------------------------------
	// Frame handlers
	// ----------------------------------------------------------------

	private handleRegister(ws: WebSocket, frame: Frame, isGateway: boolean): void {
		if (!isGateway) {
			this.sendError(ws, "invalid_frame", "Only gateway can send REGISTER");
			return;
		}

		const clients = this.state.getWebSockets("client");
		ws.send(
			JSON.stringify({
				type: "registered",
				channel: frame.channel || "",
				clients: clients.length,
			}),
		);

		// Notify existing clients that gateway is online
		const presence = JSON.stringify({ type: "presence", role: "gateway", status: "online" });
		for (const client of clients) {
			this.safeSend(client, presence);
		}
	}

	private handleJoin(ws: WebSocket, frame: Frame, isGateway: boolean, tags: string[]): void {
		if (isGateway) {
			this.sendError(ws, "invalid_frame", "Gateway cannot send JOIN");
			return;
		}

		const gateways = this.state.getWebSockets("gateway");
		const gatewayOnline = gateways.length > 0;

		ws.send(
			JSON.stringify({
				type: "joined",
				channel: frame.channel || "",
				gateway_online: gatewayOnline,
			}),
		);

		// Notify gateway that a client joined
		if (gatewayOnline) {
			const clientId = this.extractClientId(tags);
			const presence = JSON.stringify({
				type: "presence",
				role: "client",
				client_id: clientId || frame.client_id || "",
				status: "online",
			});
			for (const gw of gateways) {
				this.safeSend(gw, presence);
			}
		}
	}

	private handleData(ws: WebSocket, frame: Frame, isGateway: boolean, tags: string[], raw: string): void {
		// Payload size check (use decoded byte count since payload is base64).
		// Must match Go relay's base64DecodedLen: strip trailing '=' padding, then floor(n*3/4).
		const decodedSize = frame.payload ? base64DecodedLen(frame.payload) : 0;
		if (decodedSize > MAX_PAYLOAD_BYTES) {
			this.sendError(ws, "payload_too_large", `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
			return;
		}

		// Broadcast not allowed
		if (frame.to === "*") {
			this.sendError(ws, "invalid_frame", "Broadcast (to: *) is not allowed in v1");
			return;
		}

		if (isGateway) {
			// Gateway → specific client
			const targetId = frame.to;
			if (!targetId) {
				this.sendError(ws, "invalid_frame", "DATA from gateway must specify 'to' client_id");
				return;
			}
			const targets = this.state.getWebSockets(`id:${targetId}`);
			for (const target of targets) {
				this.safeSend(target, raw);
			}
		} else {
			// Client → gateway
			const gateways = this.state.getWebSockets("gateway");
			// Ensure 'from' is set correctly
			const clientId = this.extractClientId(tags);
			if (clientId && frame.from !== clientId) {
				// Rewrite 'from' to prevent spoofing
				frame.from = clientId;
				const corrected = JSON.stringify(frame);
				for (const gw of gateways) {
					this.safeSend(gw, corrected);
				}
			} else {
				for (const gw of gateways) {
					this.safeSend(gw, raw);
				}
			}
		}
	}

	// ----------------------------------------------------------------
	// Helpers
	// ----------------------------------------------------------------

	private extractClientId(tags: string[]): string | null {
		for (const tag of tags) {
			if (tag.startsWith("id:")) {
				return tag.slice(3);
			}
		}
		return null;
	}

	private sendError(ws: WebSocket, code: string, message: string): void {
		this.safeSend(ws, JSON.stringify({ type: "error", code, message }));
	}

	private safeSend(ws: WebSocket, data: string): void {
		try {
			ws.send(data);
		} catch {
			// Connection already closed
		}
	}

	private checkRateLimit(): boolean {
		const now = Date.now();
		if (now >= this.rateLimitResetAt) {
			this.msgCount = 0;
			this.rateLimitResetAt = now + 1000;
		}
		this.msgCount++;
		return this.msgCount <= RATE_LIMIT_PER_SECOND;
	}
}

/**
 * Estimate decoded byte count of a base64-encoded string without decoding.
 * Matches Go relay's base64DecodedLen: strip trailing '=' padding, then floor(n*3/4).
 */
function base64DecodedLen(s: string): number {
	let n = s.length;
	while (n > 0 && s[n - 1] === "=") {
		n--;
	}
	return Math.floor((n * 3) / 4);
}
