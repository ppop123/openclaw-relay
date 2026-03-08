"""Layer 0: WebSocket framing and channel management."""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any

import websockets
import websockets.exceptions

logger = logging.getLogger(__name__)

# Reconnection parameters
_INITIAL_BACKOFF = 1.0  # seconds
_MAX_BACKOFF = 60.0  # seconds
_JITTER_FACTOR = 0.25


class ChannelError(Exception):
    """Raised when the relay returns an error frame."""


class ChannelReconnected(Exception):
    """Raised by recv() after the channel reconnects at Layer 0.

    Upper layers should treat this as a signal to rebuild their session
    (e.g. redo HELLO handshake and derive fresh encryption keys).
    """


class ChannelConnection:
    """Layer 0: WebSocket connection to an OpenClaw relay server.

    Handles connect/register/join lifecycle, frame serialisation and
    automatic reconnection with exponential back-off + jitter.
    """

    def __init__(self) -> None:
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._relay_url: str | None = None
        self._closed: bool = False

        # Reconnection state
        self._backoff: float = _INITIAL_BACKOFF
        self._reconnect_lock = asyncio.Lock()

        # Populated after register/join so that reconnection can re-establish
        self._role: str | None = None  # "gateway" or "client"
        self._channel_hash: str | None = None
        self._client_id: str | None = None

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def connect(self, relay_url: str) -> None:
        """Open a WebSocket connection to *relay_url*."""
        self._relay_url = relay_url
        self._closed = False
        await self._do_connect()

    async def _do_connect(self) -> None:
        """Internal: establish the raw WebSocket."""
        assert self._relay_url is not None
        self._ws = await websockets.connect(
            self._relay_url,
            ping_interval=30,
            ping_timeout=10,
            close_timeout=5,
        )
        self._backoff = _INITIAL_BACKOFF
        logger.info("WebSocket connected to %s", self._relay_url)

    # ------------------------------------------------------------------
    # Channel lifecycle
    # ------------------------------------------------------------------

    async def register(self, channel_hash: str) -> dict:
        """Register as a *gateway* for *channel_hash*.

        Returns the ``registered`` acknowledgement frame.
        """
        self._role = "gateway"
        self._channel_hash = channel_hash

        await self._send_frame({"type": "register", "channel": channel_hash, "version": 1})
        frame = await self._recv_frame_expect("registered")
        return frame

    async def join(self, channel_hash: str, client_id: str) -> dict:
        """Join a channel as a *client*.

        Returns the ``joined`` acknowledgement frame.
        """
        self._role = "client"
        self._channel_hash = channel_hash
        self._client_id = client_id

        await self._send_frame({
            "type": "join",
            "channel": channel_hash,
            "version": 1,
            "client_id": client_id,
        })
        frame = await self._recv_frame_expect("joined")
        return frame

    # ------------------------------------------------------------------
    # Data exchange
    # ------------------------------------------------------------------

    async def send_data(self, to: str, payload: str) -> None:
        """Send a ``data`` frame to peer *to*."""
        await self._send_frame({
            "type": "data",
            "to": to,
            "payload": payload,
        })

    async def recv(self) -> dict:
        """Receive and return the next parsed frame.

        Automatically handles ``ping`` frames from the server by replying
        with ``pong``, and transparently reconnects on connection loss.
        """
        while True:
            try:
                frame = await self._recv_raw()
            except (
                websockets.exceptions.ConnectionClosed,
                websockets.exceptions.ConnectionClosedError,
                websockets.exceptions.ConnectionClosedOK,
                ConnectionError,
                OSError,
            ):
                if self._closed:
                    raise ConnectionError("Connection closed")
                await self._reconnect()
                raise ChannelReconnected()

            frame_type = frame.get("type")

            # Respond to server pings transparently
            if frame_type == "ping":
                await self._send_frame({"type": "pong"})
                continue

            if frame_type == "error":
                logger.error("Relay error: %s", frame.get("message", frame))

            return frame

    async def send_ping(self) -> None:
        """Send a client-initiated ``ping`` frame."""
        await self._send_frame({"type": "ping"})

    async def close(self) -> None:
        """Cleanly close the WebSocket."""
        self._closed = True
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        logger.info("Channel connection closed")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        """Serialise *frame* as JSON and send over the WebSocket."""
        if self._ws is None:
            raise ConnectionError("Not connected")
        raw = json.dumps(frame, separators=(",", ":"))
        await self._ws.send(raw)

    async def _recv_raw(self) -> dict:
        """Receive a single raw frame (JSON) from the WebSocket."""
        if self._ws is None:
            raise ConnectionError("Not connected")
        raw = await self._ws.recv()
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)

    async def _recv_frame_expect(self, expected_type: str) -> dict:
        """Receive frames until one matches *expected_type*.

        If an ``error`` frame arrives instead, raise ``ChannelError``.
        Server ``ping`` frames are answered transparently.
        """
        while True:
            frame = await self._recv_raw()
            ft = frame.get("type")
            if ft == expected_type:
                return frame
            if ft == "ping":
                await self._send_frame({"type": "pong"})
                continue
            if ft == "error":
                raise ChannelError(frame.get("message", str(frame)))
            # Ignore unexpected frame types during the handshake
            logger.debug("Ignoring unexpected frame during %s wait: %s", expected_type, ft)

    # ------------------------------------------------------------------
    # Reconnection with exponential back-off + jitter
    # ------------------------------------------------------------------

    async def _reconnect(self) -> None:
        """Attempt to reconnect with exponential back-off."""
        async with self._reconnect_lock:
            # Another coroutine may have reconnected while we waited for the lock.
            if self._ws is not None:
                try:
                    await self._ws.ping()
                    return
                except Exception:
                    pass

            while not self._closed:
                jitter = random.uniform(0, _JITTER_FACTOR * self._backoff)
                delay = self._backoff + jitter
                logger.info("Reconnecting in %.1fs ...", delay)
                await asyncio.sleep(delay)

                try:
                    await self._do_connect()
                except Exception as exc:
                    logger.warning("Reconnect failed: %s", exc)
                    self._backoff = min(self._backoff * 2, _MAX_BACKOFF)
                    continue

                # Re-establish channel membership
                try:
                    if self._role == "gateway" and self._channel_hash:
                        await self.register(self._channel_hash)
                    elif self._role == "client" and self._channel_hash and self._client_id:
                        await self.join(self._channel_hash, self._client_id)
                except Exception as exc:
                    logger.warning("Re-join after reconnect failed: %s", exc)
                    self._backoff = min(self._backoff * 2, _MAX_BACKOFF)
                    continue

                logger.info("Reconnected successfully")
                return

            raise ConnectionError("Connection closed, cannot reconnect")
