#!/usr/bin/env python3
"""Render one of the shell's small windows to a PNG through CDP, with alpha.

Same reason as `pet-render.py` — screen capture is unreliable in this remote
session — but parameterised by window, because the bubble and the pet are both
worth looking at and neither is reachable by grabbing the screen.

A file name suffix identifies the window (`/pet-bubble.html`, `/pet.html`, ...).
"""
import base64
import json
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def target_for(suffix):
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").endswith(suffix):
                return t
    return None


def main():
    suffix = sys.argv[1] if len(sys.argv) > 1 else "/pet.html"
    out = sys.argv[2] if len(sys.argv) > 2 else "render.png"
    target = target_for(suffix)
    if target is None:
        print("no target for", suffix)
        return 2
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
    ws.send(json.dumps({"id": 2, "method": "Page.captureScreenshot",
                        "params": {"format": "png", "captureBeyondViewport": False,
                                   "fromSurface": True}}))
    end = time.time() + 25
    data = None
    while time.time() < end:
        m = json.loads(ws.recv())
        if m.get("id") == 2:
            r = m.get("result", {})
            data = r.get("data")
            if data is None:
                print("ERR:", json.dumps(m)[:300])
            break
    ws.close()
    if data is None:
        print("no image")
        return 1
    with open(out, "wb") as fh:
        fh.write(base64.b64decode(data))
    print("saved", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
