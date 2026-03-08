"""High-level RelayClient for connecting to an OpenClaw gateway via relay."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

from .channel import ChannelConnection, ChannelError, ChannelReconnected
from .crypto import (
    KeyPair,
    SessionCipher,
    channel_token_hash,
    compute_shared_secret,
    derive_session_key,
    generate_session_nonce,
)
from .transport import TransportError, TransportLayer
from .types import Agent, ChatChunk, ChatResponse

logger = logging.getLogger(__name__)

_GATEWAY_PEER_ID = "gateway"


class RelayClient:
    """High-level client for connecting to an OpenClaw gateway via a relay server.

    Example::

        async with RelayClient(
            relay="wss://relay.example.com",
            token="my-channel-token",
            gateway_public_key="<base64>",
        ) as client:
            async for chunk in await client.chat("agent-name", "Hello!"):
                print(chunk.delta, end="")
    """

    def __init__(
        self,
        relay: str,
        token: str,
        gateway_public_key: str,
        private_key: KeyPair | None = None,
        client_id: str | None = None,
    ) -> None:
        self._relay_url = relay
        self._token = token
        self._gateway_public_key_b64 = gateway_public_key
        self._gateway_public_key_bytes = base64.b64decode(gateway_public_key)

        self._keypair = private_key or KeyPair()
        self._client_id = client_id or f"client_{uuid.uuid4().hex[:12]}"

        self._channel: ChannelConnection | None = None
        self._transport: TransportLayer | None = None
        self._connected = False
        self._closed = False
        self._session_task: asyncio.Task[None] | None = None
        self._event_handlers_registry: dict[str, list[Callable[..., Any]]] = {}

    # ------------------------------------------------------------------
    # Async context manager
    # ------------------------------------------------------------------

    async def __aenter__(self) -> RelayClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.disconnect()

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Connect to the relay, join the channel, and establish an encrypted session."""
        # Step 1: WebSocket
        channel = ChannelConnection()
        await channel.connect(self._relay_url)

        # Step 2: JOIN
        ch_hash = channel_token_hash(self._token)
        await channel.join(ch_hash, self._client_id)
        logger.info("Joined channel %s as %s", ch_hash[:16], self._client_id)

        self._channel = channel
        self._closed = False

        # Steps 3-8: HELLO handshake + transport (with retry on reconnection)
        while True:
            try:
                await self._do_hello_handshake()
                break
            except ChannelReconnected:
                logger.warning("Connection lost during initial handshake, retrying")
                continue

        # Start session monitoring loop for automatic reconnection
        self._session_task = asyncio.get_running_loop().create_task(
            self._session_loop(), name="relay-session"
        )

        logger.info("Encrypted session established with gateway")

    async def disconnect(self) -> None:
        """Cleanly shut down the transport and close the WebSocket."""
        self._closed = True
        self._connected = False
        if self._session_task is not None:
            self._session_task.cancel()
            try:
                await self._session_task
            except asyncio.CancelledError:
                pass
            self._session_task = None
        if self._transport is not None:
            await self._transport.stop()
            self._transport = None
        if self._channel is not None:
            await self._channel.close()
            self._channel = None
        logger.info("Disconnected from relay")

    async def _do_hello_handshake(self) -> None:
        """Perform HELLO/HELLO_ACK handshake and create a new encrypted transport.

        Can raise ``ChannelReconnected`` if the connection drops during the
        handshake — callers should retry.
        """
        assert self._channel is not None

        client_nonce = generate_session_nonce()
        hello_payload: dict[str, Any] = {
            "type": "hello",
            "client_public_key": base64.b64encode(self._keypair.public_key_bytes).decode(),
            "session_nonce": base64.b64encode(client_nonce).decode(),
            "protocol_version": 1,
            "capabilities": ["chat", "stream", "notify"],
        }
        await self._channel.send_data(
            to=_GATEWAY_PEER_ID,
            payload=json.dumps(hello_payload, separators=(",", ":")),
        )

        hello_ack = await self._wait_for_hello_ack(self._channel)

        gateway_pub_bytes = base64.b64decode(hello_ack["gateway_public_key"])
        gateway_nonce = base64.b64decode(hello_ack["session_nonce"])

        if gateway_pub_bytes != self._gateway_public_key_bytes:
            raise ValueError(
                "Gateway public key mismatch: the key received in HELLO_ACK does not "
                "match the expected gateway_public_key from pairing."
            )

        shared_secret = compute_shared_secret(
            self._keypair.private_key,
            gateway_pub_bytes,
        )
        session_key = derive_session_key(
            shared_secret=shared_secret,
            client_public_key=self._keypair.public_key_bytes,
            gateway_public_key=gateway_pub_bytes,
            client_session_nonce=client_nonce,
            gateway_session_nonce=gateway_nonce,
        )

        cipher = SessionCipher(session_key, SessionCipher.DIRECTION_CLIENT_TO_GATEWAY)
        transport = TransportLayer(
            channel=self._channel,
            cipher=cipher,
            my_id=self._client_id,
            peer_id=_GATEWAY_PEER_ID,
        )

        # Re-register event handlers on the new transport
        for event, handlers in self._event_handlers_registry.items():
            for handler in handlers:
                transport.on(event, handler)

        await transport.start()

        self._transport = transport
        self._connected = True

    async def _session_loop(self) -> None:
        """Monitor transport and re-establish encrypted session on reconnection."""
        try:
            while not self._closed:
                assert self._transport is not None
                await self._transport.wait_done()

                if self._closed:
                    return

                logger.info("Transport exited, re-establishing encrypted session")
                self._connected = False
                self._transport = None

                while not self._closed:
                    try:
                        await self._do_hello_handshake()
                        logger.info("Encrypted session re-established after reconnect")
                        break
                    except ChannelReconnected:
                        logger.warning("Connection lost again during re-handshake, retrying")
                        continue
                    except Exception as exc:
                        logger.error("Re-handshake failed: %s", exc)
                        await asyncio.sleep(2.0)
                        continue
        except asyncio.CancelledError:
            return

    # ------------------------------------------------------------------
    # High-level operations
    # ------------------------------------------------------------------

    async def chat(
        self,
        agent: str,
        message: str,
        stream: bool = True,
    ) -> AsyncIterator[ChatChunk] | ChatResponse:
        """Send a ``chat.send`` request.

        If *stream* is ``True`` (default), returns an async iterator of
        ``ChatChunk`` objects.  Otherwise returns a single ``ChatResponse``.
        """
        self._ensure_connected()
        assert self._transport is not None

        params: dict[str, Any] = {
            "agent": agent,
            "message": message,
        }

        if stream:
            return self._chat_stream(params)
        else:
            result = await self._transport.request("chat.send", params)
            return ChatResponse(
                content=result.get("content", ""),
                session_id=result.get("session_id", ""),
                agent=result.get("agent", agent),
                tokens=result.get("tokens", {}),
            )

    async def _chat_stream(self, params: dict[str, Any]) -> AsyncIterator[ChatChunk]:
        """Internal streaming chat helper."""
        assert self._transport is not None
        params["stream"] = True
        async for chunk in self._transport.request_stream("chat.send", params):
            yield ChatChunk(
                delta=chunk.get("delta", ""),
                session_id=chunk.get("session_id", ""),
            )

    async def agents_list(self) -> list[Agent]:
        """List agents available on the gateway."""
        self._ensure_connected()
        assert self._transport is not None

        result = await self._transport.request("agents.list", {})
        agents_raw = result.get("agents", [])
        return [
            Agent(
                name=a.get("name", ""),
                display_name=a.get("display_name", ""),
                status=a.get("status", "unknown"),
                description=a.get("description", ""),
            )
            for a in agents_raw
        ]

    async def system_status(self) -> dict[str, Any]:
        """Get gateway system status."""
        self._ensure_connected()
        assert self._transport is not None

        return await self._transport.request("system.status", {})

    def on(self, event: str, handler: Callable[..., Any]) -> None:
        """Register a handler for NOTIFY events."""
        self._event_handlers_registry.setdefault(event, []).append(handler)
        if self._transport is not None:
            self._transport.on(event, handler)

    @property
    def connected(self) -> bool:
        """Whether the client has an active encrypted session."""
        return self._connected

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_connected(self) -> None:
        if not self._connected or self._transport is None:
            raise RuntimeError("Not connected. Call connect() first.")

    @staticmethod
    async def _wait_for_hello_ack(channel: ChannelConnection, timeout: float = 30.0) -> dict[str, Any]:
        """Wait for a HELLO_ACK data frame from the gateway."""
        async def _recv() -> dict[str, Any]:
            while True:
                frame = await channel.recv()
                if frame.get("type") == "error":
                    raise ChannelError(
                        f"Relay error during handshake: [{frame.get('code', 'unknown')}] "
                        f"{frame.get('message', str(frame))}"
                    )
                if frame.get("type") != "data":
                    continue
                payload_str = frame.get("payload")
                if payload_str is None:
                    continue
                try:
                    payload = json.loads(payload_str)
                except (json.JSONDecodeError, TypeError):
                    continue
                if payload.get("type") == "hello_ack":
                    return payload

        try:
            return await asyncio.wait_for(_recv(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError("Timed out waiting for HELLO_ACK from gateway")
