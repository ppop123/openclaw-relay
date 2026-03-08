"""Layer 1: X25519 key exchange, AES-256-GCM encryption, HKDF key derivation."""

from __future__ import annotations

import hashlib
import os
import struct

from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_HKDF_INFO = b"openclaw-relay-v1"
_REPLAY_WINDOW_SIZE = 64


class KeyPair:
    """X25519 keypair for Diffie-Hellman key exchange."""

    def __init__(self) -> None:
        self.private_key = X25519PrivateKey.generate()
        self.public_key = self.private_key.public_key()

    @property
    def public_key_bytes(self) -> bytes:
        """Return the raw 32-byte public key."""
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            PublicFormat,
        )

        return self.public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)

    @classmethod
    def from_private_bytes(cls, data: bytes) -> KeyPair:
        """Reconstruct a KeyPair from raw 32-byte private key material."""
        instance = object.__new__(cls)
        instance.private_key = X25519PrivateKey.from_private_bytes(data)
        instance.public_key = instance.private_key.public_key()
        return instance


def compute_shared_secret(
    private_key: X25519PrivateKey,
    peer_public_key_bytes: bytes,
) -> bytes:
    """Perform X25519 ECDH and return the 32-byte shared secret."""
    peer_public_key = X25519PublicKey.from_public_bytes(peer_public_key_bytes)
    return private_key.exchange(peer_public_key)


def derive_session_key(
    shared_secret: bytes,
    client_public_key: bytes,
    gateway_public_key: bytes,
    client_session_nonce: bytes,
    gateway_session_nonce: bytes,
) -> bytes:
    """Derive a 32-byte AES-256 session key using HKDF-SHA256.

    salt = SHA256(client_pub || gateway_pub || client_nonce || gateway_nonce)
    key  = HKDF(ikm=shared_secret, salt=salt, info="openclaw-relay-v1", length=32)
    """
    salt_input = client_public_key + gateway_public_key + client_session_nonce + gateway_session_nonce
    salt = hashlib.sha256(salt_input).digest()

    hkdf = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=salt,
        info=_HKDF_INFO,
    )
    return hkdf.derive(shared_secret)


def generate_session_nonce() -> bytes:
    """Generate a random 32-byte session nonce."""
    return os.urandom(32)


def channel_token_hash(token: str) -> str:
    """Return the SHA-256 hex digest of *token*."""
    return hashlib.sha256(token.encode()).hexdigest()


class SessionCipher:
    """AES-256-GCM encryption / decryption with monotonic nonce counters.

    The 12-byte GCM nonce is structured as:
        [4 bytes direction prefix (big-endian)] [8 bytes counter (big-endian)]

    A sliding-window replay check (window size 64) prevents duplicate
    or out-of-order replay of received messages.
    """

    DIRECTION_CLIENT_TO_GATEWAY = 1
    DIRECTION_GATEWAY_TO_CLIENT = 2

    def __init__(self, session_key: bytes, send_direction: int) -> None:
        if len(session_key) != 32:
            raise ValueError("session_key must be 32 bytes")
        if send_direction not in (
            self.DIRECTION_CLIENT_TO_GATEWAY,
            self.DIRECTION_GATEWAY_TO_CLIENT,
        ):
            raise ValueError("send_direction must be 1 (client->gw) or 2 (gw->client)")

        self._aesgcm = AESGCM(session_key)
        self._send_direction = send_direction
        self._recv_direction = (
            self.DIRECTION_GATEWAY_TO_CLIENT
            if send_direction == self.DIRECTION_CLIENT_TO_GATEWAY
            else self.DIRECTION_CLIENT_TO_GATEWAY
        )
        self._send_counter: int = 0

        # Receive-side replay protection
        self._recv_counter: int = 0  # highest counter seen so far
        self._recv_window: set[int] = set()

    # ------------------------------------------------------------------
    # Encryption
    # ------------------------------------------------------------------

    def encrypt(self, plaintext: bytes) -> bytes:
        """Encrypt *plaintext* and return ``nonce(12) || ciphertext || tag(16)``."""
        nonce = struct.pack(">I", self._send_direction) + struct.pack(">Q", self._send_counter)
        self._send_counter += 1
        ct = self._aesgcm.encrypt(nonce, plaintext, None)
        return nonce + ct

    # ------------------------------------------------------------------
    # Decryption
    # ------------------------------------------------------------------

    def decrypt(self, data: bytes) -> bytes:
        """Decrypt *data* (``nonce(12) || ciphertext || tag(16)``).

        Raises ``ValueError`` on replay or authentication failure.
        """
        if len(data) < 12 + 16:
            raise ValueError("Ciphertext too short")

        nonce = data[:12]
        ciphertext_and_tag = data[12:]

        # Validate direction prefix
        direction = struct.unpack(">I", nonce[:4])[0]
        if direction != self._recv_direction:
            raise ValueError(
                f"Wrong nonce direction prefix: expected {self._recv_direction}, got {direction}"
            )

        counter = struct.unpack(">Q", nonce[4:12])[0]

        # Anti-replay ---------------------------------------------------
        if self._recv_counter > 0 or len(self._recv_window) > 0:
            if counter <= self._recv_counter - _REPLAY_WINDOW_SIZE:
                raise ValueError("Replay detected: counter too old")
            if counter <= self._recv_counter and counter in self._recv_window:
                raise ValueError("Replay detected: duplicate counter")

        plaintext = self._aesgcm.decrypt(nonce, ciphertext_and_tag, None)

        # Update bookkeeping only after successful decryption
        if counter > self._recv_counter:
            self._recv_counter = counter
        self._recv_window.add(counter)

        # Trim the window to keep only the last 64 counters
        self._recv_window = {c for c in self._recv_window if c > self._recv_counter - _REPLAY_WINDOW_SIZE}

        return plaintext
