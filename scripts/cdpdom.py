#!/usr/bin/env python3
"""Report what the content webview actually rendered, to tell 'still loading'
from 'crashed'."""
import json
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
print("url:", content.get("url"))
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
    m = rf(ident, time.time() + 20)
    if not m:
        return "<timeout>"
    res = m.get("result", {})
    if "exceptionDetails" in res:
        return "<exception> " + json.dumps(res["exceptionDetails"])[:300]
    return res.get("result", {}).get("value")


print("readyState:", ev("document.readyState"))
print("body children:", ev("document.body ? document.body.children.length : -1"))
print("total elements:", ev("document.querySelectorAll('*').length"))
print("buttons (any):", ev("document.querySelectorAll('button').length"))
print("visible text:", ev(
    "((document.body||{}).innerText||'').replace(/\\s+/g,' ').trim().slice(0, 600)"))
print("root div html:", ev(
    "(function(){var r=document.querySelector('#root,#app,[id]');"
    "return r ? r.outerHTML.slice(0, 600) : 'no root'})()"))
print("style/link count:", ev("document.querySelectorAll('style,link[rel=stylesheet]').length"))
print("scripts:", ev(
    "JSON.stringify([].slice.call(document.querySelectorAll('script')).map(function(s){return s.src||'(inline)'}).slice(0,12))"))
ws.close()
