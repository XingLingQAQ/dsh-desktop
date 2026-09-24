#!/usr/bin/env python3
"""Drop files on the pet and report what the queue did.

Dropping is the whole gesture of this phase, so testing the queue commands
directly would leave the interesting half unproven: whether the window actually
receives a file drop at all. This tries the real path first — a CDP drag event
carrying file paths — and falls back to the shell command, reporting which one
it had to use rather than quietly testing the easier thing.

On Windows a drag from Explorer is an OLE drop handled by WebView2, so a
renderer-synthesised drag may not reach it. If that is what happens here, the
fallback result is still worth having, and the report says so plainly.
"""
import json
import os
import sys
import tempfile
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"
CORE = "/node_modules/.vite/deps/@tauri-apps_api_core.js"


def find(suffix):
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").endswith(suffix):
                return t
    return None


class Page:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    def call(self, method, params=None, timeout=25):
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


QUEUE = ("(async () => { const c = await import('%s');"
         " return await c.invoke('pet_queue'); })()" % CORE)


def make_files():
    """Two real files, so the size and name in the queue are not fabricated."""
    base = os.path.join(tempfile.gettempdir(), "pet-drop-test")
    os.makedirs(base, exist_ok=True)
    a = os.path.join(base, "drop-alpha.txt")
    b = os.path.join(base, "drop-beta.md")
    with open(a, "w", encoding="utf-8") as fh:
        fh.write("alpha\n" * 40)
    with open(b, "w", encoding="utf-8") as fh:
        fh.write("# beta\n" * 10)
    return [a, b]


def main():
    files = make_files()
    print("test files:")
    for f in files:
        print("  ", f, os.path.getsize(f), "bytes")

    target = find("/pet.html")
    if target is None:
        print("no pet window")
        return 2
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    page = Page(ws)
    page.call("Runtime.enable")
    print("\nqueue before:", page.js(QUEUE))

    # Clear so the test starts from a known state.
    page.js("(async () => { const c = await import('%s');"
            " await c.invoke('pet_clear_files'); return 'ok'; })()" % CORE)

    print("\n--- attempt 1: CDP drag event with file paths ---")
    data = {
        "items": [],
        "files": files,
        "dragOperationsMask": 1,
    }
    for kind in ("dragEnter", "dragOver", "drop"):
        page.call("Input.dispatchDragEvent", {"type": kind, "x": 60, "y": 80, "data": data})
        time.sleep(0.15)
    time.sleep(1.0)
    after_drag = page.js(QUEUE)
    print("  queue after CDP drag:", after_drag)
    got = json.loads(after_drag) if after_drag and after_drag.startswith("{") else {"count": 0}

    if got.get("count", 0) == 0:
        print("\n--- attempt 2: the shell command the drop handler calls ---")
        result = page.js(
            "(async () => { const c = await import('%s');"
            " const n = await c.invoke('pet_add_files', { paths: %s });"
            " return String(n); })()" % (CORE, json.dumps(files)))
        print("  pet_add_files ->", result)
        time.sleep(0.4)
        after_cmd = page.js(QUEUE)
        print("  queue after command:", after_cmd)
        print("\nNOTE: the OS drop path was not exercised; only the handler behind it.")
    else:
        print("\nNOTE: the real drop path worked end to end.")

    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
