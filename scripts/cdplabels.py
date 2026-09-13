#!/usr/bin/env python3
"""Report what clickable labels the page currently shows, to navigate reliably."""
import json
import sys
import time
import urllib.request

import websocket

VER = "http://127.0.0.1:9222/json/version"
ws = websocket.create_connection(
    json.load(urllib.request.urlopen(VER, timeout=3))["webSocketDebuggerUrl"],
    timeout=10, suppress_origin=True,
)


def rf(ident, deadline):
    while time.time() < deadline:
        try:
            m = json.loads(ws.recv())
        except Exception:
            break
        if m.get("id") == ident:
            return m
    return None


ws.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
targets = (rf(1, time.time() + 5) or {}).get("result", {}).get("targetInfos", [])
content = next((t for t in targets if t.get("type") == "page"
                and "1420" not in t.get("url", "")
                and t.get("url", "").startswith("http://127.0.0.1:")), None)
if not content:
    print("no content target")
    raise SystemExit
ws.send(json.dumps({"id": 2, "method": "Target.attachToTarget",
                    "params": {"targetId": content["targetId"], "flatten": True}}))
sid = rf(2, time.time() + 5)["result"]["sessionId"]
ws.send(json.dumps({"id": 3, "method": "Runtime.enable", "sessionId": sid}))
rf(3, time.time() + 3)

counter = [10]


def ev(expr):
    counter[0] += 1
    ident = counter[0]
    ws.send(json.dumps({"id": ident, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True},
                        "sessionId": sid}))
    m = rf(ident, time.time() + 15)
    return m.get("result", {}).get("result", {}).get("value") if m else None


if len(sys.argv) > 1:
    print(ev(
        "(function(t){var ns=[].slice.call(document.querySelectorAll('button,[role=button],[role=tab],a,li'));"
        "for(var i=0;i<ns.length;i++){var n=ns[i];"
        "if((n.textContent||'').trim()===t && n.offsetParent!==null){n.click();return 'clicked '+t}}"
        "return 'not found: '+t})(" + json.dumps(sys.argv[1]) + ")"))
    time.sleep(1.6)

print("dialogs:", ev("document.querySelectorAll('[role=dialog]').length"))
print("mgr present:", ev("document.querySelectorAll('.dsx-mgr').length"))
print("native head:", ev("document.querySelectorAll('.dsx-mgr-native-head').length"))
print("clickable labels:", ev(
    "JSON.stringify([].slice.call(document.querySelectorAll('button,[role=tab],[role=button]'))"
    ".filter(function(n){return n.offsetParent!==null})"
    ".map(function(n){return (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,24)})"
    ".filter(function(s){return s.length>0}).slice(0,40))"))
ws.close()
