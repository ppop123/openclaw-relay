"""Tests for openclaw_relay.crypto – SessionCipher, key derivation, and token hashing."""

import hashlib
import os
import struct

import pytest

from openclaw_relay.crypto import (
    SessionCipher,
    channel_token_hash,
    derive_session_key,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cipher_pair(key: bytes | None = None):
    """Return (client_cipher, gateway_cipher) sharing the same session key."""
    if key is None:
        key = os.urandom(32)
    client = SessionCipher(key, SessionCipher.DIRECTION_CLIENT_TO_GATEWAY)
    gateway = SessionCipher(key, SessionCipher.DIRECTION_GATEWAY_TO_CLIENT)
    return client, gateway


# ---------------------------------------------------------------------------
# 1. Basic encrypt / decrypt roundtrip
# ---------------------------------------------------------------------------

class TestEncryptDecryptRoundtrip:

    def test_client_to_gateway(self):
        client, gateway = _make_cipher_pair()
        plaintext = b"hello from client"
        ciphertext = client.encrypt(plaintext)
        assert gateway.decrypt(ciphertext) == plaintext

    def test_gateway_to_client(self):
        client, gateway = _make_cipher_pair()
        plaintext = b"hello from gateway"
        ciphertext = gateway.encrypt(plaintext)
        assert client.decrypt(ciphertext) == plaintext

    def test_roundtrip_multiple_messages(self):
        client, gateway = _make_cipher_pair()
        for i in range(10):
            msg = f"message {i}".encode()
            ct = client.encrypt(msg)
            assert gateway.decrypt(ct) == msg

    def test_empty_plaintext(self):
        client, gateway = _make_cipher_pair()
        ct = client.encrypt(b"")
        assert gateway.decrypt(ct) == b""

    def test_large_plaintext(self):
        client, gateway = _make_cipher_pair()
        big = os.urandom(64 * 1024)
        ct = client.encrypt(big)
        assert gateway.decrypt(ct) == big


# ---------------------------------------------------------------------------
# 2. Direction prefix validation
# ---------------------------------------------------------------------------

class TestDirectionPrefix:

    def test_client_cipher_uses_direction_1(self):
        client, _ = _make_cipher_pair()
        ct = client.encrypt(b"x")
        nonce = ct[:12]
        direction = struct.unpack(">I", nonce[:4])[0]
        assert direction == SessionCipher.DIRECTION_CLIENT_TO_GATEWAY

    def test_gateway_cipher_uses_direction_2(self):
        _, gateway = _make_cipher_pair()
        ct = gateway.encrypt(b"x")
        nonce = ct[:12]
        direction = struct.unpack(">I", nonce[:4])[0]
        assert direction == SessionCipher.DIRECTION_GATEWAY_TO_CLIENT

    def test_counter_increments(self):
        client, _ = _make_cipher_pair()
        ct1 = client.encrypt(b"a")
        ct2 = client.encrypt(b"b")
        counter1 = struct.unpack(">Q", ct1[4:12])[0]
        counter2 = struct.unpack(">Q", ct2[4:12])[0]
        assert counter1 == 0
        assert counter2 == 1


# ---------------------------------------------------------------------------
# 3. Cross-direction rejection
# ---------------------------------------------------------------------------

class TestCrossDirectionRejection:

    def test_client_rejects_own_ciphertext(self):
        """Client encrypts with direction 1; client expects to receive direction 2."""
        client, _ = _make_cipher_pair()
        ct = client.encrypt(b"self-addressed")
        with pytest.raises(ValueError, match="Wrong nonce direction prefix"):
            client.decrypt(ct)

    def test_gateway_rejects_own_ciphertext(self):
        """Gateway encrypts with direction 2; gateway expects to receive direction 1."""
        _, gateway = _make_cipher_pair()
        ct = gateway.encrypt(b"self-addressed")
        with pytest.raises(ValueError, match="Wrong nonce direction prefix"):
            gateway.decrypt(ct)


# ---------------------------------------------------------------------------
# 4. Replay detection
# ---------------------------------------------------------------------------

class TestReplayDetection:

    def test_duplicate_ciphertext_rejected(self):
        client, gateway = _make_cipher_pair()
        ct = client.encrypt(b"once only")
        gateway.decrypt(ct)  # first time OK
        with pytest.raises(ValueError, match="Replay detected"):
            gateway.decrypt(ct)  # second time fails

    def test_old_counter_rejected(self):
        """After advancing counter far enough, old counters fall outside the window."""
        client, gateway = _make_cipher_pair()
        # Encrypt and decrypt the first message (counter 0)
        first_ct = client.encrypt(b"first")
        gateway.decrypt(first_ct)

        # Advance by more than the replay window (64)
        for i in range(70):
            ct = client.encrypt(f"msg-{i}".encode())
            gateway.decrypt(ct)

        # Replaying the very first message should be rejected (counter too old)
        with pytest.raises(ValueError, match="Replay detected"):
            gateway.decrypt(first_ct)

    def test_out_of_order_within_window_accepted(self):
        """Messages received out of order but within the window should be accepted."""
        client, gateway = _make_cipher_pair()
        ct0 = client.encrypt(b"msg-0")
        ct1 = client.encrypt(b"msg-1")
        ct2 = client.encrypt(b"msg-2")

        # Receive them out of order: 2, 0, 1
        assert gateway.decrypt(ct2) == b"msg-2"
        assert gateway.decrypt(ct0) == b"msg-0"
        assert gateway.decrypt(ct1) == b"msg-1"


# ---------------------------------------------------------------------------
# 5. Key derivation determinism
# ---------------------------------------------------------------------------

class TestKeyDerivation:

    def test_same_inputs_same_output(self):
        shared_secret = os.urandom(32)
        client_pub = os.urandom(32)
        gateway_pub = os.urandom(32)
        client_nonce = os.urandom(32)
        gateway_nonce = os.urandom(32)

        key1 = derive_session_key(shared_secret, client_pub, gateway_pub, client_nonce, gateway_nonce)
        key2 = derive_session_key(shared_secret, client_pub, gateway_pub, client_nonce, gateway_nonce)

        assert key1 == key2
        assert len(key1) == 32

    def test_different_nonces_different_keys(self):
        shared_secret = os.urandom(32)
        client_pub = os.urandom(32)
        gateway_pub = os.urandom(32)

        key1 = derive_session_key(shared_secret, client_pub, gateway_pub, os.urandom(32), os.urandom(32))
        key2 = derive_session_key(shared_secret, client_pub, gateway_pub, os.urandom(32), os.urandom(32))

        assert key1 != key2

    def test_different_secrets_different_keys(self):
        client_pub = os.urandom(32)
        gateway_pub = os.urandom(32)
        nonce_c = os.urandom(32)
        nonce_g = os.urandom(32)

        key1 = derive_session_key(os.urandom(32), client_pub, gateway_pub, nonce_c, nonce_g)
        key2 = derive_session_key(os.urandom(32), client_pub, gateway_pub, nonce_c, nonce_g)

        assert key1 != key2


# ---------------------------------------------------------------------------
# 6. channel_token_hash
# ---------------------------------------------------------------------------

class TestChannelTokenHash:

    def test_known_token(self):
        token = "my-secret-token"
        expected = hashlib.sha256(token.encode()).hexdigest()
        assert channel_token_hash(token) == expected

    def test_empty_token(self):
        expected = hashlib.sha256(b"").hexdigest()
        assert channel_token_hash("") == expected

    def test_returns_hex_string(self):
        result = channel_token_hash("anything")
        assert isinstance(result, str)
        assert len(result) == 64
        # Must be valid hex
        int(result, 16)
