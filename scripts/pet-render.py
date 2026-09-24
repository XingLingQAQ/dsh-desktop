#!/usr/bin/env python3
"""Render the pet page to a PNG through CDP, with alpha preserved.

This exists because capturing the screen does not work reliably in this remote
session — `CopyFromScreen` returns a blank bitmap once the display geometry
changes. Asking the renderer for its own surface sidesteps that, and it is a
better check anyway: the PNG keeps the alpha channel, so the pixels the pet does
*not* draw come back transparent instead of showing whatever happened to be on
the desktop behind it.
"""
import base64
import json
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def pet_ws():
    with urllib.request.urlopen(LIST, timeout=3) as r:
        for t in json.load(r):
            if t.get("type") == "page" and "pet.html" in t.get("url", ""):
                return t["webSocketDebuggerUrl"]
    return None


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "pet-render.png"
    url = pet_ws()
    if url is None:
        print("NO_PET_TARGET")
        return 2
    ws = websocket.create_connection(url, timeout=25, suppress_origin=True)
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
            if "data" in r:
                data = r["data"]
            else:
                print("ERR:", json.dumps(m)[:300])
            break
    ws.close()
    if data is None:
        print("NO_IMAGE")
        return 1
    with open(out, "wb") as fh:
        fh.write(base64.b64decode(data))
    print(f"saved {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
