#!/usr/bin/env python3
"""Click send and capture the server's answer to `/api/session/prompt`.

The pet's host plugin received zero `session/event`s after a UI send, while the
same subscription received 33 of them when the prompt was issued host-side. The
question is whether the UI's request is even accepted, so this reads the response
body rather than guessing from the absence of a reply in the transcript.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"


def page_target():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").startswith("http://127.0.0.1:"):
                return t
    return None


class Page:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    def call(self, method, params=None, timeout=20):
        self.n += 1
        mid = self.n
        msg = {"id": mid, "method": method}
        if params:
            msg["params"] = params
        self.ws.send(json.dumps(msg))
        end = time.time() + timeout
        while time.time() < end:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                return m.get("result", {})
        return None

    def js(self, expr):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r:
            return "EXC: " + json.dumps(r["exceptionDetails"])[:300]
        return r.get("result", {}).get("value")


def main():
    target = page_target()
    if target is None:
        print("no page")
        return 2
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30,
                                     suppress_origin=True)
    page = Page(ws)
    page.call("Network.enable")
    page.call("Runtime.enable")

    # Make sure there is something to send.
    typed = page.js("document.querySelector('div[contenteditable=true]').innerText")
    if not typed:
        print("composer empty; type first with dsh-send.py")
        ws.close()
        return 2
    print("composer:", json.dumps(typed, ensure_ascii=False))
    print("click:", page.js("""(() => {
      const b = document.querySelector('button[class*="_primary"]');
      if (!b) return 'NO_BUTTON';
      b.click();
      return 'clicked';
    })()"""))

    prompt_id = None
    deadline = time.time() + 25
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.5, deadline - time.time()))
            m = json.loads(ws.recv())
        except Exception:
            break
        method = m.get("method")
        params = m.get("params", {})
        if method == "Network.requestWillBeSent":
            url = params.get("request", {}).get("url", "")
            if "session/prompt" in url:
                prompt_id = params.get("requestId")
                print("REQUEST:")
                print("  url :", url)
                print("  body:", (params["request"].get("postData") or "")[:400])
        elif method == "Network.responseReceived" and params.get("requestId") == prompt_id:
            resp = params.get("response", {})
            print("RESPONSE status:", resp.get("status"), resp.get("statusText"))
            body = page.call("Network.getResponseBody", {"requestId": prompt_id})
            text = (body or {}).get("body", "")
            print("RESPONSE body:", text[:600])
            break
        elif method == "Network.loadingFailed" and params.get("requestId") == prompt_id:
            print("LOADING FAILED:", params.get("errorText"))
            break
    if prompt_id is None:
        print("no session/prompt request observed")
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
