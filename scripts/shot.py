#!/usr/bin/env python3
# Capture a PNG of the DSH content webview via CDP Page.captureScreenshot.
import json, sys, base64, urllib.request, time
import websocket

LIST = "http://127.0.0.1:9222/json"

def find_content():
    import re
    with urllib.request.urlopen(LIST, timeout=3) as r:
        targets = json.load(r)
    for t in targets:
        if t.get("type") != "page":
            continue
        if re.match(r"http://127\.0\.0\.1:\d+/", t.get("url", "")):
            return t["webSocketDebuggerUrl"]
    return None

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
    ws_url = find_content()
    if not ws_url:
        print("NO_TARGET"); sys.exit(2)
    ws = websocket.create_connection(ws_url, timeout=20, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
    ws.recv()
    ws.send(json.dumps({"id": 2, "method": "Page.captureScreenshot",
                        "params": {"format": "png", "captureBeyondViewport": False}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 2:
            data = msg["result"]["data"]
            with open(out, "wb") as f:
                f.write(base64.b64decode(data))
            print("WROTE", out)
            break
    ws.close()

if __name__ == "__main__":
    main()
