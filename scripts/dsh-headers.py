#!/usr/bin/env python3
"""Measure the request headers the browser actually sends for the DSH page.

The host rejects a request whose headers exceed roughly 2 KB with a 431, and
Chromium's own baseline headers already use most of that budget. Reading the
real numbers is the only way to tell which part is over: the URL, a cookie, or
the baseline itself.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def page_target():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and "token=" in t.get("url", ""):
                return t
    return None


def main():
    target = page_target()
    if target is None:
        print("no DSH page target")
        return 2
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    n = 0

    def call(method, params=None, timeout=20):
        nonlocal n
        n += 1
        msg = {"id": n, "method": method}
        if params:
            msg["params"] = params
        ws.send(json.dumps(msg))
        end = time.time() + timeout
        while time.time() < end:
            m = json.loads(ws.recv())
            if m.get("id") == n:
                return m.get("result", {})
        return None

    call("Network.enable")
    call("Page.enable")

    # Cookies the browser holds for this origin, which it will send with every
    # request and which therefore come straight out of the header budget.
    cookies = call("Network.getCookies", {"urls": [target["url"].split("?")[0]]})
    for c in (cookies or {}).get("cookies", []):
        print(f"cookie: {c.get('name')} = {len(c.get('value',''))} bytes")

    call("Page.reload", {"ignoreCache": True})

    deadline = time.time() + 20
    seen = 0
    while time.time() < deadline and seen < 40:
        try:
            m = json.loads(ws.recv())
        except Exception:
            break
        method = m.get("method")
        if method == "Network.requestWillBeSentExtraInfo":
            headers = m["params"].get("headers", {})
            total = sum(len(k) + len(str(v)) + 4 for k, v in headers.items())
            url = m["params"].get("associatedCookies")
            seen += 1
            print(f"--- request #{seen}: {len(headers)} headers, ~{total} bytes of header text")
            for k, v in sorted(headers.items(), key=lambda kv: -len(str(kv[1])))[:8]:
                print(f"      {k}: {len(str(v))} bytes")
        elif method == "Network.responseReceived":
            resp = m["params"]["response"]
            if resp.get("status", 0) >= 400:
                print(f"!!! response {resp['status']} {resp.get('statusText','')} for {resp.get('url','')[:90]}")
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
