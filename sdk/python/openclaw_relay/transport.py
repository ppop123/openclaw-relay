"""Layer 2: Request/response, streaming, and multiplexing over an encrypted channel."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
from collections.abc import AsyncIterator, Callable
from typing import Any

from .channel import ChannelConnection, ChannelReconnected
from .crypto import SessionCipher

logger = logging.getLogger(__name__)

# Sentinel used to signal end-of-stream inside queues.
_STREAM_END = object()


class TransportError(Exception):
    """Raised when a remote RESPONSE carries an error payload."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.remote_message = message


class TransportLayer:
    """Layer 2: multiplexed request/response and streaming over an encrypted channel.

    Message types handled:
        REQUEST, RESPONSE, STREAM_START, STREAM_CHUNK, STREAM_END, CANCEL, NOTIFY
    """

    def __init__(
        self,
        channel: ChannelConnection,
        cipher: SessionCipher,
        my_id: str,
        peer_id: str,
    ) -> None:
        self._channel = channel
        self._cipher = cipher
        self._my_id = my_id
        self._peer_id = peer_id

        # In-flight requests waiting for a single RESPONSE
        self._pending: dict[str, asyncio.Future[dict]] = {}

        # Streaming responses: request_id -> queue of dicts (or _STREAM_END)
        self._streams: dict[str, asyncio.Queue[Any]] = {}

        # NOTIFY event handlers
        self._event_handlers: dict[str, list[Callable[..., Any]]] = {}

        self._recv_task: asyncio.Task[None] | None = None
        self._done_event = asyncio.Event()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the background receiver loop."""
        if self._recv_task is not None and not self._recv_task.done():
            return
        self._recv_task = asyncio.get_running_loop().create_task(
            self._recv_loop(), name="transport-recv"
        )

    async def stop(self) -> None:
        """Cancel the background receiver loop."""
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
            self._recv_task = None

        # Wake up anyone still waiting
        cancel_err: dict[str, Any] = {"code": "transport_closed", "message": "Transport stopped"}
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(TransportError(cancel_err["code"], cancel_err["message"]))
        self._pending.clear()

        for q in self._streams.values():
            await q.put(_STREAM_END)
        self._streams.clear()

    def _fail_all_pending(self, code: str, message: str) -> None:
        """Fail all pending requests and end all streams."""
        err = TransportError(code, message)
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()

        for q in self._streams.values():
            q.put_nowait(err)
        self._streams.clear()

    async def wait_done(self) -> None:
        """Wait for the recv loop to finish (without cancelling it)."""
        await self._done_event.wait()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @staticmethod
    def _generate_id() -> str:
        return f"msg_{secrets.token_hex(4)}"

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        timeout: float = 120.0,
    ) -> dict[str, Any]:
        """Send a REQUEST and wait for the corresponding RESPONSE.

        Returns the ``result`` dict on success; raises ``TransportError`` on
        remote error.
        """
        msg_id = self._generate_id()
        msg: dict[str, Any] = {
            "id": msg_id,
            "type": "request",
            "method": method,
            "params": params,
        }

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[msg_id] = future

        try:
            await self._send_encrypted(msg)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise TimeoutError(f"Request {msg_id} ({method}) timed out after {timeout}s")
        except Exception:
            self._pending.pop(msg_id, None)
            raise

    async def request_stream(
        self,
        method: str,
        params: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        """Send a REQUEST with ``stream=True`` and yield ``STREAM_CHUNK`` data dicts.

        The iterator ends when a ``STREAM_END`` frame is received.
        """
        msg_id = self._generate_id()
        msg: dict[str, Any] = {
            "id": msg_id,
            "type": "request",
            "method": method,
            "params": params,
        }

        queue: asyncio.Queue[Any] = asyncio.Queue()
        self._streams[msg_id] = queue

        try:
            await self._send_encrypted(msg)

            while True:
                item = await queue.get()
                if item is _STREAM_END:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            self._streams.pop(msg_id, None)

    async def cancel(self, request_id: str) -> None:
        """Send a CANCEL for an in-flight request."""
        msg: dict[str, Any] = {
            "id": request_id,
            "type": "cancel",
        }
        await self._send_encrypted(msg)

    async def notify(self, event: str, data: dict[str, Any]) -> None:
        """Send a one-way NOTIFY message (no response expected)."""
        msg: dict[str, Any] = {
            "id": self._generate_id(),
            "type": "notify",
            "event": event,
            "data": data,
        }
        await self._send_encrypted(msg)

    def on(self, event: str, handler: Callable[..., Any]) -> None:
        """Register *handler* for NOTIFY messages with the given *event* name."""
        self._event_handlers.setdefault(event, []).append(handler)

    # ------------------------------------------------------------------
    # Background receiver
    # ------------------------------------------------------------------

    async def _recv_loop(self) -> None:
        """Continuously receive frames, decrypt, and dispatch."""
        try:
            while True:
                frame = await self._channel.recv()
                frame_type = frame.get("type")

                # Handle relay-level error frames — fail all pending immediately
                if frame_type == "error":
                    code = frame.get("code", "relay_error")
                    message = frame.get("message", "Unknown relay error")
                    logger.error("Relay error: [%s] %s", code, message)
                    self._fail_all_pending(code, message)
                    continue

                if frame_type != "data":
                    # Only data frames carry encrypted L2 messages
                    continue

                payload_str = frame.get("payload")
                if payload_str is None:
                    continue

                try:
                    payload_bytes = base64.b64decode(payload_str) if isinstance(payload_str, str) else payload_str
                    plaintext = self._cipher.decrypt(payload_bytes)
                    msg = json.loads(plaintext)
                except Exception:
                    logger.warning("Failed to decrypt/parse incoming data frame", exc_info=True)
                    continue

                await self._dispatch(msg)
        except ChannelReconnected:
            logger.info("Channel reconnected, failing pending requests")
            self._fail_all_pending("reconnected", "Connection lost, session will be re-established")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Transport recv loop crashed")
        finally:
            self._done_event.set()

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        """Route a decrypted Layer 2 message to the appropriate handler."""
        msg_type = msg.get("type")
        msg_id = msg.get("id")

        if msg_type == "response":
            future = self._pending.pop(msg_id, None)
            if future is None or future.done():
                logger.debug("Orphaned RESPONSE for %s", msg_id)
                return
            if "error" in msg:
                err = msg["error"]
                future.set_exception(
                    TransportError(err.get("code", "unknown"), err.get("message", ""))
                )
            else:
                future.set_result(msg.get("result", {}))

        elif msg_type == "stream_start":
            # Ensure queue exists (it should already from request_stream)
            if msg_id not in self._streams:
                self._streams[msg_id] = asyncio.Queue()

        elif msg_type == "stream_chunk":
            queue = self._streams.get(msg_id)
            if queue is not None:
                await queue.put(msg.get("data", {}))
            else:
                logger.debug("Orphaned STREAM_CHUNK for %s", msg_id)

        elif msg_type == "stream_end":
            queue = self._streams.get(msg_id)
            if queue is not None:
                await queue.put(_STREAM_END)
            # Stream cleanup happens in request_stream's finally block

        elif msg_type == "notify":
            event = msg.get("event", "")
            data = msg.get("data", {})
            handlers = self._event_handlers.get(event, [])
            for handler in handlers:
                try:
                    result = handler(event, data)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("Notify handler for '%s' failed", event)

        elif msg_type == "cancel":
            # A peer is cancelling one of our in-flight operations.
            logger.info("Received CANCEL for %s", msg_id)

        else:
            logger.debug("Unknown L2 message type: %s", msg_type)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _send_encrypted(self, msg: dict[str, Any]) -> None:
        """Encrypt and send a Layer 2 message to the peer."""
        plaintext = json.dumps(msg, separators=(",", ":")).encode()
        ciphertext = self._cipher.encrypt(plaintext)
        payload_str = base64.b64encode(ciphertext).decode("ascii")
        await self._channel.send_data(to=self._peer_id, payload=payload_str)
