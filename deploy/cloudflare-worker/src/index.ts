/**
 * OpenClaw Relay — Cloudflare Workers Edition (EXPERIMENTAL)
 *
 * A lightweight WebSocket relay using Durable Objects.
 * Each channel is a Durable Object that holds gateway + client WebSocket connections.
 *
 * NOTE: This implementation uses URL-based routing (/ws/<channel_hash>?role=...)
 * which differs from the standard protocol where clients connect to /ws and send
 * register/join frames. Clients targeting this deployment must construct the URL
 * with the channel hash and role parameters. See protocol docs for details.
 *
 * URL scheme:
 *   /ws/<channel_hash>?role=gateway
 *   /ws/<channel_hash>?role=client&id=<client_id>
 *   /status
 */

export { RelayChannel } from "./relay-channel";

export interface Env {
	RELAY_CHANNEL: DurableObjectNamespace;
}

const CHANNEL_HASH_RE = /^\/ws\/([a-f0-9]{64})$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// --- CORS preflight ---
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: corsHeaders(),
			});
		}

		// --- Health / status ---
		if (url.pathname === "/status") {
			return jsonResponse(
				{
					name: "openclaw-relay",
					version: "0.2.1",
					protocol_version: 1,
					public: true,
					runtime: "cloudflare-workers",
				},
				200,
			);
		}

		// --- WebSocket endpoint ---
		const match = url.pathname.match(CHANNEL_HASH_RE);
		if (match) {
			const channelHash = match[1];
			const role = url.searchParams.get("role");

			if (role !== "gateway" && role !== "client") {
				return jsonResponse(
					{ error: "Missing or invalid role parameter. Use ?role=gateway or ?role=client&id=<client_id>" },
					400,
				);
			}

			if (role === "client" && !url.searchParams.get("id")) {
				return jsonResponse({ error: "Missing id parameter for client role" }, 400);
			}

			// Route to the Durable Object for this channel
			const id = env.RELAY_CHANNEL.idFromName(channelHash);
			const stub = env.RELAY_CHANNEL.get(id);

			// Forward the full request (including WebSocket upgrade headers)
			return stub.fetch(request);
		}

		// --- Fallback ---
		return jsonResponse({ error: "Not found. WebSocket endpoint: /ws/<channel_hash>" }, 404);
	},
};

function jsonResponse(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...corsHeaders(),
		},
	});
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}
