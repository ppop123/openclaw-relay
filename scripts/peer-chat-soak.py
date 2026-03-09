#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / '.tmp' / f'peer-chat-soak-{datetime.now().strftime("%Y%m%d-%H%M%S")}'

SOAK_PROMPT = (
    '你正在和另一台 OpenClaw 做耐久对话测试。'
    '后续每次只回 1 句，不超过 24 个汉字，不要 Markdown，不要前言。'
    '话题围绕 agent 协作、发现、信任、工具调用。'
)

TOPIC_PROMPT = (
    '你正在和另一台 OpenClaw 进行自主对话。'
    '围绕指定主题自然交流，保持每次只回 1 句、不超过 36 个汉字，不要 Markdown，不要前言。'
    '目标是推进观点，而不是互相附和。'
)

@dataclass
class PeerRuntime:
    label: str
    public_key: str
    call_cmd_prefix: list[str]


def run_json(cmd: list[str]) -> Any:
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out)


def call_gateway(runtime: PeerRuntime, method: str, params: dict[str, Any] | None = None) -> Any:
    payload = json.dumps(params or {}, ensure_ascii=False)
    if runtime.label == 'remote':
        inner = f'openclaw --profile {shlex.quote(args.remote_profile)} gateway call {shlex.quote(method)} --params {shlex.quote(payload)} --timeout {args.timeout_ms} --json'
        return run_json(['ssh', '-o', 'BatchMode=yes', args.remote, f"zsh -lic {shlex.quote(inner)}"])
    return run_json(['openclaw', 'gateway', 'call', method, '--params', payload, '--timeout', str(args.timeout_ms), '--json'])


def call_peer(runtime: PeerRuntime, peer_public_key: str, method: str, params: dict[str, Any]) -> Any:
    return call_gateway(runtime, 'relay.peer.call', {
        'peerPublicKey': peer_public_key,
        'method': method,
        'params': params,
    })


def send_chat(runtime: PeerRuntime, peer_public_key: str, session_id: str | None, message: str) -> tuple[str, str, float]:
    params: dict[str, Any] = {
        'message': message,
        'stream': False,
        'deliver': False,
    }
    if session_id:
        params['session_id'] = session_id
    attempts = 0
    last_error: Exception | None = None
    while attempts < args.retries:
        attempts += 1
        start = time.time()
        try:
            result = call_peer(runtime, peer_public_key, 'chat.send', params)['result']
            elapsed = time.time() - start
            return result['content'], result['session_id'], elapsed
        except Exception as error:  # pragma: no cover - live-only retry path
            last_error = error
            if attempts >= args.retries:
                raise
            time.sleep(args.retry_sleep_seconds)
    raise last_error or RuntimeError('chat send failed')


def send_status(runtime: PeerRuntime, peer_public_key: str) -> Any:
    return call_peer(runtime, peer_public_key, 'system.status', {})['result']


def dial(runtime: PeerRuntime, peer_public_key: str, client_id: str) -> Any:
    return call_gateway(runtime, 'relay.peer.dial', {
        'targetPublicKey': peer_public_key,
        'clientId': client_id,
        'body': {'purpose': 'peer-chat-soak'},
        'timeoutMs': 20000,
        'pollIntervalMs': 1000,
    })


def get_selfcheck_local() -> Any:
    return run_json(['openclaw', 'gateway', 'call', 'relay.peer.selfcheck', '--params', '{}', '--json'])


def get_selfcheck_remote() -> Any:
    inner = f'openclaw --profile {shlex.quote(args.remote_profile)} gateway call relay.peer.selfcheck --params {shlex.quote("{}")} --json'
    return run_json(['ssh', '-o', 'BatchMode=yes', args.remote, f"zsh -lic {shlex.quote(inner)}"])


def make_prompt(previous: str | None, speaker: str, turn_index: int) -> str:
    if args.topic:
        if previous is None:
            return f'{TOPIC_PROMPT} 你是{speaker}。本轮主题：{args.topic}。先提出一个明确观点，再抛给对方一个问题。'
        clipped = previous.strip().replace('\n', ' ')[:100]
        return f'主题：{args.topic}。你是{speaker}。对方刚说：{clipped}。请只回一句，给出新观点或反驳。'
    if previous is None:
        return f'{SOAK_PROMPT} 你是{speaker}。先简短自我介绍，再问一个协作问题。'
    clipped = previous.strip().replace('\n', ' ')[:80]
    return f'耐久测试继续。你是{speaker}。对方刚说：{clipped}。请只回一句，推进话题。'


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def append_jsonl(path: Path, payload: Any) -> None:
    with path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + '\n')


parser = argparse.ArgumentParser(description='Run a bidirectional peer-chat soak between two OpenClaw gateways.')
parser.add_argument('--minutes', type=float, default=15.0, help='How long to run the conversation.')
parser.add_argument('--topic', default='', help='Run an autonomous topic conversation instead of a soak-only exchange.')
parser.add_argument('--turn-limit', type=int, default=0, help='Optional max turns before stopping.')
parser.add_argument('--remote', default='wangyan@192.168.50.8', help='SSH target for the second OpenClaw host.')
parser.add_argument('--remote-profile', default='relaypeer', help='OpenClaw profile on the remote host.')
parser.add_argument('--timeout-ms', type=int, default=45000, help='Gateway call timeout in ms.')
parser.add_argument('--retries', type=int, default=2, help='Retries for a timed-out chat turn.')
parser.add_argument('--retry-sleep-seconds', type=float, default=2.0, help='Sleep between chat retries.')
args = parser.parse_args()

RUN_ROOT.mkdir(parents=True, exist_ok=True)
transcript_path = RUN_ROOT / 'conversation.jsonl'
summary_path = RUN_ROOT / 'summary.json'

local_selfcheck = get_selfcheck_local()
remote_selfcheck = get_selfcheck_remote()
write_json(RUN_ROOT / 'local-selfcheck.json', local_selfcheck)
write_json(RUN_ROOT / 'remote-selfcheck.json', remote_selfcheck)

local = PeerRuntime(
    label='local',
    public_key=local_selfcheck['account']['publicKey'],
    call_cmd_prefix=[],
)
remote = PeerRuntime(
    label='remote',
    public_key=remote_selfcheck['account']['publicKey'],
    call_cmd_prefix=[],
)

# establish both directions
local_dial = dial(local, remote.public_key, 'local-peer-soak')
remote_dial = dial(remote, local.public_key, 'remote-peer-soak')
write_json(RUN_ROOT / 'local-dial.json', local_dial)
write_json(RUN_ROOT / 'remote-dial.json', remote_dial)

status_sample = {
    'local_to_remote': send_status(local, remote.public_key),
    'remote_to_local': send_status(remote, local.public_key),
}
write_json(RUN_ROOT / 'initial-status.json', status_sample)

end_time = time.time() + args.minutes * 60
turn = 0
local_session_id: str | None = None
remote_session_id: str | None = None
last_remote: str | None = None
last_local: str | None = None
latencies: list[float] = []

# remote speaks first
remote_text, remote_session_id, elapsed = send_chat(local, remote.public_key, remote_session_id, make_prompt(None, '远端 OpenClaw', turn))
latencies.append(elapsed)
turn += 1
last_remote = remote_text
append_jsonl(transcript_path, {'turn': turn, 'speaker': 'remote', 'latencySeconds': round(elapsed, 3), 'content': remote_text, 'sessionId': remote_session_id, 'ts': datetime.now().isoformat()})

while time.time() < end_time:
    if args.turn_limit and turn >= args.turn_limit:
        break
    local_text, local_session_id, elapsed = send_chat(remote, local.public_key, local_session_id, make_prompt(last_remote, '本机 OpenClaw', turn))
    latencies.append(elapsed)
    turn += 1
    last_local = local_text
    append_jsonl(transcript_path, {'turn': turn, 'speaker': 'local', 'latencySeconds': round(elapsed, 3), 'content': local_text, 'sessionId': local_session_id, 'ts': datetime.now().isoformat()})
    if time.time() >= end_time or (args.turn_limit and turn >= args.turn_limit):
        break

    remote_text, remote_session_id, elapsed = send_chat(local, remote.public_key, remote_session_id, make_prompt(last_local, '远端 OpenClaw', turn))
    latencies.append(elapsed)
    turn += 1
    last_remote = remote_text
    append_jsonl(transcript_path, {'turn': turn, 'speaker': 'remote', 'latencySeconds': round(elapsed, 3), 'content': remote_text, 'sessionId': remote_session_id, 'ts': datetime.now().isoformat()})

final = {
    'durationMinutes': args.minutes,
    'topic': args.topic or None,
    'turnLimit': args.turn_limit or None,
    'turnCount': turn,
    'localTurns': sum(1 for _ in open(transcript_path, 'r', encoding='utf-8') if '"speaker": "local"' in _),
    'remoteTurns': sum(1 for _ in open(transcript_path, 'r', encoding='utf-8') if '"speaker": "remote"' in _),
    'avgLatencySeconds': round(sum(latencies) / len(latencies), 3) if latencies else None,
    'maxLatencySeconds': round(max(latencies), 3) if latencies else None,
    'localSessionId': local_session_id,
    'remoteSessionId': remote_session_id,
    'artifacts': str(RUN_ROOT),
    'lastLocal': last_local,
    'lastRemote': last_remote,
}
write_json(summary_path, final)
print(json.dumps(final, ensure_ascii=False, indent=2))
