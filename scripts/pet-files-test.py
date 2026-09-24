#!/usr/bin/env python3
"""Walk the whole file-queue path and report each step.

Covers: files enter the queue, the bubble renders them, a send carries them to
the host, and the queue empties only when the host accepted. Each step is printed
separately because they fail in different places and a single pass/fail would not
say which.
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


def targets():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        return json.load(r)


def find(suffix):
    for t in targets():
        if t.get("type") == "page" and t.get("url", "").endswith(suffix):
            return t
    return None


def host_base():
    for t in targets():
        u = t.get("url", "")
        if u.startswith("http://127.0.0.1:"):
            return u.split("/?")[0].rstrip("/")
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


def make_files():
    base = os.path.join(tempfile.gettempdir(), "pet-queue-test")
    os.makedirs(base, exist_ok=True)
    made = []
    for name, body in (("report-final.txt", "x" * 900), ("diagram.svg", "<svg/>")):
        path = os.path.join(base, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        made.append(path)
    return made


def main():
    files = make_files()
    bubble = find("/pet-bubble.html")
    if bubble is None:
        print("no bubble window")
        return 2
    ws = websocket.create_connection(bubble["webSocketDebuggerUrl"], timeout=25,
                                     suppress_origin=True)
    page = Page(ws)
    page.call("Runtime.enable")

    print("=== 1. clear, then add two files ===")
    print("  clear ->", page.js("(async()=>{const c=await import('%s');"
                                " return String(await c.invoke('pet_clear_files'));})()" % CORE))
    print("  add   ->", page.js("(async()=>{const c=await import('%s');"
                                " return String(await c.invoke('pet_add_files',{paths:%s}));})()"
                                % (CORE, json.dumps(files))))
    time.sleep(0.8)
    print("  queue ->", page.js("(async()=>{const c=await import('%s');"
                                " return await c.invoke('pet_queue');})()" % CORE))

    print("\n=== 2. what the bubble renders ===")
    print(" ", page.js("""(() => {
      const card = document.querySelector('.pet-bubble');
      const names = [...document.querySelectorAll('.pet-bubble *')]
        .map(n => n.textContent || '')
        .filter(t => t.includes('report-final') || t.includes('diagram'));
      const buttons = [...document.querySelectorAll('.pet-bubble button')].length;
      return JSON.stringify({ text: (card ? card.innerText : '').replace(/\\n/g, ' | '),
                              buttons });
    })()"""))

    print("\n=== 3. send with the queue ===")
    # Pick a session from the corpus when nothing is current yet. Driving the DSH
    # composer to create one is unreliable — its send button ignores a
    # synthesised click often enough to waste a lot of time — and it is not what
    # is under test here: the bubble calls exactly this command, so calling it
    # directly tests the same path minus the button's own handler.
    print(" ", page.js("(async()=>{const c=await import('%s');"
                       " const q=JSON.parse(await c.invoke('pet_sessions'));"
                       " const id=q.current || (q.sessions[0] && q.sessions[0].id);"
                       " if(!id) return 'NO_SESSION';"
                       " const paths=JSON.parse(await c.invoke('pet_queue')).files.map(f=>f.path);"
                       " return await c.invoke('pet_send_prompt',"
                       "   {sessionId:id, text:'probe-files: 只回复 ok', files:paths});})()" % CORE))
    time.sleep(1.0)
    print("  queue after send ->", page.js("(async()=>{const c=await import('%s');"
                                           " return await c.invoke('pet_queue');})()" % CORE))

    time.sleep(4.0)
    base = host_base()
    if base:
        with urllib.request.urlopen(base + "/dsh-desktop-pet/state", timeout=10) as r:
            s = json.loads(r.read().decode("utf-8"))
        print("  host state ->", json.dumps({k: s.get(k) for k in
                                            ("activity", "sessionId", "title", "turn")},
                                           ensure_ascii=False))

    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
