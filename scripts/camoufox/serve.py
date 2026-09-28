#!/usr/bin/env python3
"""Camoufox Playwright-server launcher for the TypeScript pipeline.

Spawns Camoufox as a websocket Playwright server; the TS side connects with
`firefox.connect(wsEndpoint)` (same protocol version as the project's
playwright 1.62 — pythonlib ships the matching driver).

Why a pinned device file (data/fb_device.json): Camoufox re-rolls hardware
noise seeds (canvas/audio/fonts) and picks a fresh fingerprint on EVERY launch
(daijro/camoufox#442). Same cookies + new device identity reads as session
hijacking to anti-fraud. We therefore pin a real fingerprint preset and the
three noise seeds once per account and reuse them forever.

Usage:
    serve.py [--headless] [--device PATH] [--proxy URL] [--port N] [--ws-path P]

The ws endpoint is printed to stdout by the Playwright driver ("ws://...").
The process blocks until killed; closing stdin also shuts the server down.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from random import randint
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DEVICE_PATH = REPO_ROOT / "data" / "fb_device.json"


def load_or_create_device(path: Path, requested_os: str | None = None) -> dict:
    if path.exists():
        device = json.loads(path.read_text(encoding="utf-8"))
        if requested_os and requested_os != device.get("os"):
            raise ValueError(
                f"Device {path} is pinned to {device.get('os')}, not {requested_os}"
            )
        return device
    from camoufox.utils import get_random_preset

    host_os = "macos" if sys.platform == "darwin" else "windows" if sys.platform == "win32" else "linux"
    device_os = requested_os or host_os
    device = {
        "os": device_os,
        "locale": "en-US",
        # A real in-the-wild fingerprint preset, pinned once per account.
        "fingerprint_preset": get_random_preset(os=device_os),
        "seeds": {
            "fonts:spacing_seed": randint(1, 4_294_967_295),  # nosec — anti-fingerprint noise seed
            "audio:seed": randint(1, 4_294_967_295),  # nosec
            "canvas:seed": randint(1, 4_294_967_295),  # nosec
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(device, indent=2, ensure_ascii=False), encoding="utf-8")
    path.chmod(0o600)
    print(f"🔐 Pinned new device identity -> {path}", file=sys.stderr)
    return device


def parse_proxy(raw: str | None) -> dict | None:
    if not raw:
        return None
    parsed = urlsplit(raw if "://" in raw else f"http://{raw}")
    if not parsed.hostname or not parsed.port:
        raise ValueError(f"Cannot parse proxy: {raw!r}")
    proxy = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        proxy["username"] = parsed.username
    if parsed.password:
        proxy["password"] = parsed.password
    return proxy


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--device", type=Path, default=DEFAULT_DEVICE_PATH)
    parser.add_argument("--proxy", default=None)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--ws-path", default=None)
    parser.add_argument(
        "--os", default=None, help="override spoofed OS (default: from device file)"
    )
    args = parser.parse_args()

    device = load_or_create_device(args.device, args.os)

    options = {
        "headless": args.headless,
        "os": device["os"],
        "locale": device.get("locale", "en-US"),
        "block_webrtc": True,
        "fingerprint_preset": device["fingerprint_preset"],
        # Pin the per-launch noise seeds so the device looks identical on
        # every run (set_into() honours user-provided config keys).
        "config": dict(device["seeds"]),
        "humanize": False,
        "enable_cache": True,
    }
    proxy = parse_proxy(args.proxy)
    if proxy:
        options["proxy"] = proxy
        options["geoip"] = True
    if args.port:
        options["port"] = args.port
    if args.ws_path:
        options["ws_path"] = args.ws_path

    from camoufox.server import launch_server

    launch_server(**options)


if __name__ == "__main__":
    main()
