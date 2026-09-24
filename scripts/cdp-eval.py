#!/usr/bin/env python3
"""Evaluate JavaScript in a named window's page.

Windows are matched on title or exact URL, because the main window's URL is the
bare dev-server root and is therefore a prefix of every other page's.
"""
import json
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def targets():
    with urllib.request.urlopen(LIST, timeout=3) as r:
        return json.load(r)


def find(sub):
    pages = [t for t in targets() if t.get("type") == "page"]
    for t in pages:
        if sub == t.get("title") or sub == t.get("url"):
            return t
    for t in pages:
        if sub in t.get("title", "") or sub in t.get("url", ""):
            return t
    return None


def main():
    which, expr = sys.argv[1], sys.argv[2]
    timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 25
    target = find(which)
    if target is None:
        print("NO_TARGET:", which)
        return 2
    print("target:", target.get("title"), "|", target.get("url"))
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=timeout,
                                     suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    time.sleep(0.3)
    ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True,
                                   "awaitPromise": True}}))
    end = time.time() + timeout
    while time.time() < end:
        try:
            m = json.loads(ws.recv())
        except Exception:
            print("TIMEOUT waiting for result")
            break
        if m.get("id") == 2:
            r = m.get("result", {})
            if "exceptionDetails" in r:
                print("EXC:", json.dumps(r["exceptionDetails"])[:400])
            else:
                v = r.get("result", {}).get("value")
                print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
            break
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
