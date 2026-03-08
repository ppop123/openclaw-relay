"""Tests for openclaw_relay.transport – TransportLayer over a mock channel."""

from __future__ import annotations

import asyncio
import base64
import json
import os

import pytest

from openclaw_relay.channel import ChannelReconnected
from openclaw_relay.crypto import SessionCipher
from openclaw_relay.transport import TransportError, TransportLayer


# ---------------------------------------------------------------------------
# Mock channel
# ---------------------------------------------------------------------------

class MockChannel:
    """Fake ChannelConnection for testing."""

    def __init__(self):
        self._incoming: asyncio.Queue = asyncio.Queue()
        self._outgoing: list = []

    async def recv(self) -> dict:
        return await self._incoming.get()

    async def send_data(self, to: str, payload: str) -> None:
        self._outgoing.append({"to": to, "payload": payload})

    def inject(self, frame: dict) -> None:
        """Push a frame that recv() will return."""
        self._incoming.put_nowait(frame)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_session_key() -> bytes:
    return os.urandom(32)


def _make_transport_pair(channel: MockChannel, key: bytes | None = None):
    """Return (transport, client_cipher, gateway_cipher) wired to *channel*.

    The transport plays the client role (sends with direction 1).
    """
    if key is None:
        key = _make_session_key()
    client_cipher = SessionCipher(key, SessionCipher.DIRECTION_CLIENT_TO_GATEWAY)
    gateway_cipher = SessionCipher(key, SessionCipher.DIRECTION_GATEWAY_TO_CLIENT)

    transport = TransportLayer(
        channel=channel,
        cipher=client_cipher,
        my_id="client-1",
        peer_id="gateway-1",
    )
    return transport, client_cipher, gateway_cipher


def _encrypt_l2_frame(cipher: SessionCipher, msg: dict) -> str:
    """Encrypt a Layer 2 message dict and return base64-encoded payload string."""
    plaintext = json.dumps(msg, separators=(",", ":")).encode()
    ct = cipher.encrypt(plaintext)
    return base64.b64encode(ct).decode("ascii")


# ---------------------------------------------------------------------------
# 1. ChannelReconnected propagation
# ---------------------------------------------------------------------------

class TestChannelReconnected:

    @pytest.mark.asyncio
    async def test_reconnected_fails_pending_and_resolves_wait_done(self):
        """When the channel raises ChannelReconnected, all pending requests
        should fail with code 'reconnected' and wait_done() should resolve."""
        channel = MockChannel()
        transport, _, _ = _make_transport_pair(channel)

        await transport.start()

        # Issue a request that will remain pending
        req_task = asyncio.create_task(
            transport.request("echo", {"msg": "hi"}, timeout=5.0)
        )
        # Give the event loop a moment so request() registers the future
        await asyncio.sleep(0.05)

        # Now inject a frame that will cause recv() to raise ChannelReconnected
        # We do this by replacing the channel's recv with one that raises.
        original_recv = channel.recv

        async def _raise_reconnected():
            raise ChannelReconnected()

        channel.recv = _raise_reconnected  # type: ignore[assignment]

        # Unblock the recv loop: inject a dummy frame first so the loop
        # is at the await-recv point, then it will call our patched recv.
        # Actually, the recv loop is already blocked on channel.recv().
        # We need to feed it a frame so it loops back and hits the patched recv.
        channel.inject({"type": "ping"})  # ignored by transport (not "data" or "error")

        # Wait for the recv loop to finish
        await asyncio.wait_for(transport.wait_done(), timeout=2.0)

        # The pending request should have failed with "reconnected"
        with pytest.raises(TransportError) as exc_info:
            await req_task
        assert exc_info.value.code == "reconnected"

    @pytest.mark.asyncio
    async def test_reconnected_with_no_pending(self):
        """ChannelReconnected with no pending requests should still resolve wait_done()."""
        channel = MockChannel()
        transport, _, _ = _make_transport_pair(channel)

        await transport.start()

        async def _raise_reconnected():
            raise ChannelReconnected()

        channel.recv = _raise_reconnected  # type: ignore[assignment]
        channel.inject({"type": "ping"})

        await asyncio.wait_for(transport.wait_done(), timeout=2.0)


# ---------------------------------------------------------------------------
# 2. Relay error fails pending
# ---------------------------------------------------------------------------

class TestRelayErrorFailsPending:

    @pytest.mark.asyncio
    async def test_error_frame_fails_all_pending(self):
        """A relay error frame should fail all pending requests with the error code."""
        channel = MockChannel()
        transport, _, _ = _make_transport_pair(channel)

        await transport.start()

        # Issue a request that will be pending
        req_task = asyncio.create_task(
            transport.request("do_something", {"x": 1}, timeout=5.0)
        )
        await asyncio.sleep(0.05)

        # Inject a relay error frame
        channel.inject({
            "type": "error",
            "code": "rate_limited",
            "message": "too fast",
        })

        # The pending request should fail with the relay error
        with pytest.raises(TransportError) as exc_info:
            await asyncio.wait_for(req_task, timeout=2.0)
        assert exc_info.value.code == "rate_limited"
        assert "too fast" in exc_info.value.remote_message

        await transport.stop()

    @pytest.mark.asyncio
    async def test_error_frame_with_multiple_pending(self):
        """All pending requests should fail, not just one."""
        channel = MockChannel()
        transport, _, _ = _make_transport_pair(channel)

        await transport.start()

        req1 = asyncio.create_task(transport.request("a", {}, timeout=5.0))
        req2 = asyncio.create_task(transport.request("b", {}, timeout=5.0))
        await asyncio.sleep(0.05)

        channel.inject({
            "type": "error",
            "code": "server_error",
            "message": "internal failure",
        })

        for req in (req1, req2):
            with pytest.raises(TransportError) as exc_info:
                await asyncio.wait_for(req, timeout=2.0)
            assert exc_info.value.code == "server_error"

        await transport.stop()


# ---------------------------------------------------------------------------
# 3. Request / response lifecycle
# ---------------------------------------------------------------------------

class TestRequestResponseLifecycle:

    @pytest.mark.asyncio
    async def test_request_returns_result(self):
        """A request should send an encrypted data frame and return the decrypted response."""
        channel = MockChannel()
        key = _make_session_key()
        transport, client_cipher, gateway_cipher = _make_transport_pair(channel, key)

        await transport.start()

        async def _respond():
            """Wait for the outgoing request, decrypt it, and inject a response."""
            # Wait for the request to appear in the outgoing queue
            for _ in range(50):
                if channel._outgoing:
                    break
                await asyncio.sleep(0.01)

            assert len(channel._outgoing) >= 1, "No outgoing frame captured"
            sent = channel._outgoing[0]

            # Decrypt the sent payload to get the request ID
            payload_bytes = base64.b64decode(sent["payload"])
            plaintext = gateway_cipher.decrypt(payload_bytes)
            request_msg = json.loads(plaintext)

            assert request_msg["type"] == "request"
            assert request_msg["method"] == "greet"
            msg_id = request_msg["id"]

            # Build and inject an encrypted response
            response_msg = {
                "id": msg_id,
                "type": "response",
                "result": {"greeting": "hello back"},
            }
            encrypted_payload = _encrypt_l2_frame(gateway_cipher, response_msg)
            channel.inject({
                "type": "data",
                "from": "gateway-1",
                "payload": encrypted_payload,
            })

        responder = asyncio.create_task(_respond())

        result = await asyncio.wait_for(
            transport.request("greet", {"name": "alice"}, timeout=5.0),
            timeout=5.0,
        )

        assert result == {"greeting": "hello back"}
        await responder
        await transport.stop()

    @pytest.mark.asyncio
    async def test_request_remote_error(self):
        """A response with an error payload should raise TransportError."""
        channel = MockChannel()
        key = _make_session_key()
        transport, client_cipher, gateway_cipher = _make_transport_pair(channel, key)

        await transport.start()

        async def _respond_with_error():
            for _ in range(50):
                if channel._outgoing:
                    break
                await asyncio.sleep(0.01)

            sent = channel._outgoing[0]
            payload_bytes = base64.b64decode(sent["payload"])
            plaintext = gateway_cipher.decrypt(payload_bytes)
            request_msg = json.loads(plaintext)
            msg_id = request_msg["id"]

            response_msg = {
                "id": msg_id,
                "type": "response",
                "error": {"code": "not_found", "message": "no such method"},
            }
            encrypted_payload = _encrypt_l2_frame(gateway_cipher, response_msg)
            channel.inject({
                "type": "data",
                "from": "gateway-1",
                "payload": encrypted_payload,
            })

        responder = asyncio.create_task(_respond_with_error())

        with pytest.raises(TransportError) as exc_info:
            await asyncio.wait_for(
                transport.request("nonexistent", {}, timeout=5.0),
                timeout=5.0,
            )

        assert exc_info.value.code == "not_found"
        assert "no such method" in exc_info.value.remote_message
        await responder
        await transport.stop()

    @pytest.mark.asyncio
    async def test_send_data_destination(self):
        """Verify that send_data is called with the correct peer_id."""
        channel = MockChannel()
        transport, _, _ = _make_transport_pair(channel)

        await transport.start()

        # Fire-and-forget request (we don't need a response for this check)
        req_task = asyncio.create_task(
            transport.request("ping", {}, timeout=1.0)
        )
        await asyncio.sleep(0.05)

        assert len(channel._outgoing) >= 1
        assert channel._outgoing[0]["to"] == "gateway-1"

        req_task.cancel()
        try:
            await req_task
        except (asyncio.CancelledError, TimeoutError, TransportError):
            pass
        await transport.stop()


# ---------------------------------------------------------------------------
# 4. Handshake error propagation
# ---------------------------------------------------------------------------

class TestHandshakeErrorPropagation:
    """Verify that relay errors during handshake cause immediate failure."""

    @pytest.mark.asyncio
    async def test_relay_error_during_hello_ack_wait(self):
        """If relay sends an error frame while waiting for HELLO_ACK,
        _wait_for_hello_ack should raise ChannelError immediately."""
        from openclaw_relay.channel import ChannelError
        from openclaw_relay.client import RelayClient

        channel = MockChannel()

        # Inject a relay error frame (not a data frame)
        channel.inject({"type": "error", "code": "rate_limited", "message": "too fast"})

        with pytest.raises(ChannelError, match="rate_limited"):
            await RelayClient._wait_for_hello_ack(channel, timeout=5.0)

    @pytest.mark.asyncio
    async def test_relay_error_after_non_data_frames(self):
        """Error should be caught even if preceded by other non-data frames."""
        from openclaw_relay.channel import ChannelError
        from openclaw_relay.client import RelayClient

        channel = MockChannel()

        # Inject some non-data frames first, then an error
        channel.inject({"type": "presence", "role": "gateway", "status": "online"})
        channel.inject({"type": "pong"})
        channel.inject({"type": "error", "code": "channel_full", "message": "no room"})

        with pytest.raises(ChannelError, match="channel_full"):
            await RelayClient._wait_for_hello_ack(channel, timeout=5.0)
