#!/usr/bin/env python3
"""Print every console message / exception from the content webview for N seconds.

Usage: cdpconsole.py [seconds]
"""
import json
import sys
import time
import urllib.request

import websocket

VER = "http://127.0.0.1:9222/json/version"


def bws():
    return json.load(urllib.request.urlopen(VER, timeout=3))["webSocketDebuggerUrl"]


def recv_for(ws, want_id, deadline):
    while time.time() < deadline:
        try:
            m = json.loads(ws.recv())
        except Exception:
            break
        if m.get("id") == want_id:
            return m
    return None


def attach_content(ws):
    ws.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
    m = recv_for(ws, 1, time.time() + 5)
    targets = (m or {}).get("result", {}).get("targetInfos", [])
    content = next(
        (
            t
            for t in targets
            if t.get("type") == "page"
            and "1420" not in t.get("url", "")
            and t.get("url", "").startswith("http://127.0.0.1:")
        ),
        None,
    )
    if not content:
        return None
    ws.send(
        json.dumps(
            {
                "id": 2,
                "method": "Target.attachToTarget",
                "params": {"targetId": content["targetId"], "flatten": True},
            }
        )
    )
    m = recv_for(ws, 2, time.time() + 5)
    return (m or {}).get("result", {}).get("sessionId")


def arg_text(arg):
    if "value" in arg:
        return str(arg["value"])
    return arg.get("description") or arg.get("type", "?")


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
    ws = websocket.create_connection(bws(), timeout=10, suppress_origin=True)
    sid = attach_content(ws)
    if not sid:
        print("no content webview", flush=True)
        return
    ws.send(json.dumps({"id": 10, "method": "Runtime.enable", "sessionId": sid}))
    recv_for(ws, 10, time.time() + 3)
    print("LISTENING", flush=True)
    deadline = time.time() + secs
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.4, deadline - time.time()))
            m = json.loads(ws.recv())
        except Exception:
            continue
        method = m.get("method")
        if method == "Runtime.consoleAPICalled":
            p = m.get("params", {})
            print(f"[{p.get('type')}] " + " ".join(arg_text(a) for a in p.get("args", []))[:500], flush=True)
        elif method == "Runtime.exceptionThrown":
            det = m.get("params", {}).get("exceptionDetails", {})
            print("[exception] " + str(det.get("text", "")) + " " + str(det.get("exception", {}).get("description", ""))[:500], flush=True)
    print("DONE", flush=True)
    ws.close()


if __name__ == "__main__":
    main()
