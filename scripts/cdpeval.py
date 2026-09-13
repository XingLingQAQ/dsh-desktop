#!/usr/bin/env python3
# Minimal CDP Runtime.evaluate helper for the dsh content webview.
# Usage: cdpeval.py "<js expression>"
import json, sys, time
import websocket

LIST = "http://127.0.0.1:9222/json"

def targets():
    import urllib.request
    with urllib.request.urlopen(LIST, timeout=3) as r:
        return json.load(r)

def find_target(url_substr):
    for t in targets():
        if t.get("type") == "page" and url_substr in t.get("url",""):
            return t["webSocketDebuggerUrl"]
    return None

def find_content():
    import re
    # The content webview serves the DSH host UI on an OS-assigned 127.0.0.1
    # port; pick the page target that is not the shell dev server or splash.
    for t in targets():
        url = t.get("url", "")
        if t.get("type") != "page":
            continue
        m = re.match(r"http://127\.0\.0\.1:(\d+)/", url)
        if m:
            return t["webSocketDebuggerUrl"]
    return None

def main():
    expr = sys.argv[1] if len(sys.argv) > 1 else "1+1"
    ws_url = find_content()
    if not ws_url:
        print("NO_TARGET"); sys.exit(2)
    # Edge/Chromium rejects WS handshakes whose Origin isn't in
    # --remote-allow-origins. Suppress the Origin header entirely so the
    # loopback debugger accepts the connection regardless of flags.
    ws = websocket.create_connection(ws_url, timeout=10, suppress_origin=True)
    ws.send(json.dumps({"id":1,"method":"Runtime.enable"}))
    # drain any responses
    deadline = time.time()+2
    while time.time() < deadline:
        try:
            ws.recv()
            break
        except Exception:
            break
    ws.send(json.dumps({"id":2,"method":"Runtime.evaluate","params":{"expression":expr,"returnByValue":True,"awaitPromise":True}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 2:
            res = msg.get("result",{})
            if "exceptionDetails" in res:
                print("EXC:", json.dumps(res["exceptionDetails"], ensure_ascii=False)[:4000])
            else:
                print(json.dumps(res.get("result",{}).get("value"), ensure_ascii=False)[:8000])
            break
    ws.close()

if __name__ == "__main__":
    main()
