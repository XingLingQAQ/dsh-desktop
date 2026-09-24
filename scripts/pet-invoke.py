#!/usr/bin/env python3
"""Invoke a shell command from the pet page and print the result.

The page cannot see the Tauri API through a global (`withGlobalTauri` is off),
but in dev the Vite server exposes it as a real module URL, so a dynamic import
reaches the same `invoke` the page itself uses. That makes it possible to drive
the shell's own commands while verifying, instead of restarting the app to
exercise each entry point.
"""
import json
import sys
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"
CORE = "/node_modules/.vite/deps/@tauri-apps_api_core.js"
WINDOW = "/node_modules/.vite/deps/@tauri-apps_api_window.js"


def pet_ws():
    with urllib.request.urlopen(LIST, timeout=3) as r:
        for t in json.load(r):
            if t.get("type") == "page" and "pet.html" in t.get("url", ""):
                return t["webSocketDebuggerUrl"]
    return None


def main():
    cmd = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    expr = (
        "(async () => {"
        f"  const core = await import('{CORE}');"
        f"  const win = await import('{WINDOW}');"
        f"  const out = await core.invoke({json.dumps(cmd)}, {json.dumps(args)});"
        "  let geom = null;"
        "  try {"
        "    const w = win.getCurrentWindow();"
        "    const p = await w.outerPosition(); const s = await w.outerSize();"
        "    geom = { visible: await w.isVisible(), pos: [p.x, p.y],"
        "             size: [s.width, s.height], scale: await w.scaleFactor() };"
        "  } catch (e) { geom = 'denied: ' + String(e).slice(0, 90); }"
        "  return JSON.stringify({ result: out, geom });"
        "})()"
    )
    url = pet_ws()
    if url is None:
        print("NO_PET_TARGET")
        return 2
    ws = websocket.create_connection(url, timeout=25, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    time.sleep(0.3)
    ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True,
                                   "awaitPromise": True}}))
    end = time.time() + 25
    while time.time() < end:
        m = json.loads(ws.recv())
        if m.get("id") == 2:
            r = m.get("result", {})
            if "exceptionDetails" in r:
                print("EXC:", json.dumps(r["exceptionDetails"])[:500])
            else:
                print(json.dumps(json.loads(r["result"]["value"]), indent=2,
                                 ensure_ascii=False))
            break
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
