#!/usr/bin/env python3
"""Check that each session mood actually changes the pet's face.

Reading the stylesheet tells you what was written; this tells you what the
browser computed. They differ often enough — a selector that never matches, a
property another rule overrides — that the check is worth having.

`data-mood` is set directly on the root rather than by sending a `pet-state`
event, because the question here is only whether the *styling* of each mood
works. The event path is checked separately, against the host route.
"""
import json
import time
import urllib.request

import websocket

LIST = "http://127.0.0.1:9222/json"

MOODS = ["idle", "thinking", "tool", "waiting", "done", "error", "happy"]

PROBE = """(async () => {
  const root = document.querySelector('.pet-root')
  if (!root) return 'NO_PET_ROOT'
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const read = (sel, props) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = cs[p]
    return out
  }
  const before = root.getAttribute('data-mood')
  const result = {}
  for (const mood of %s) {
    root.setAttribute('data-mood', mood)
    // The cheeks and the mouth are transitioned, so reading immediately returns
    // the value they are leaving, not the one they are heading to.
    await wait(360)
    result[mood] = {
      earLeft: read('.pet-ear-left', ['transform']),
      earRight: read('.pet-ear-right', ['transform']),
      eye: read('.pet-eye-left', ['transform']),
      mouth: read('.pet-mouth', ['height', 'width', 'borderRadius', 'borderTopWidth', 'borderBottomWidth', 'opacity']),
      cheek: read('.pet-cheek-left', ['opacity']),
      busy: read('.pet-busy', ['display']),
      figureAnim: read('.pet-figure', ['animationName']),
    }
  }
  root.setAttribute('data-mood', before)
  return JSON.stringify(result)
})()""" % json.dumps(MOODS)


def pet_ws():
    with urllib.request.urlopen(LIST, timeout=3) as r:
        for t in json.load(r):
            if t.get("type") == "page" and t.get("url", "").endswith("/pet.html"):
                return t["webSocketDebuggerUrl"]
    return None


def main():
    url = pet_ws()
    if url is None:
        print("NO_PET_TARGET")
        return 2
    ws = websocket.create_connection(url, timeout=25, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    time.sleep(0.3)
    ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                        "params": {"expression": PROBE, "returnByValue": True,
                                   "awaitPromise": True}}))
    end = time.time() + 20
    while time.time() < end:
        m = json.loads(ws.recv())
        if m.get("id") == 2:
            r = m.get("result", {})
            if "exceptionDetails" in r:
                print("EXC:", json.dumps(r["exceptionDetails"])[:400])
            else:
                data = json.loads(r["result"]["value"])
                for mood, v in data.items():
                    print(f"--- {mood} ---")
                    print("  ears  :", v["earLeft"]["transform"], "/", v["earRight"]["transform"])
                    print("  eye   :", v["eye"]["transform"])
                    print("  mouth :", v["mouth"])
                    print("  cheek :", v["cheek"]["opacity"], " busy:", v["busy"]["display"],
                          " anim:", v["figureAnim"]["animationName"])
            break
    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
