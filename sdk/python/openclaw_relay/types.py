"""Data classes for OpenClaw Relay messages and events."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ChatChunk:
    """A single chunk from a streaming chat response."""

    delta: str
    session_id: str


@dataclass
class ChatResponse:
    """A complete (non-streaming) chat response."""

    content: str
    session_id: str
    agent: str
    tokens: dict = field(default_factory=dict)


@dataclass
class Agent:
    """An agent available on the gateway."""

    name: str
    display_name: str
    status: str
    description: str
