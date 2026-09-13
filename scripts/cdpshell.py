#!/usr/bin/env python3
# Invoke a Tauri command on the shell window (localhost:1420) via CDP,
# fire-and-forget + poll pattern (avoids awaitPromise hang when the shell
# webview is backgrounded and Tauri IPC callbacks don't flush promptly).
# Usage: cdpshell.py <command_name> [json_args]
import json, sys, time, urllib.request, websocket

LIST = "http://127.0.0.1:9222/json"

def shell_ws():
    for t in json.load(urllib.request.urlopen(LIST, timeout=3)):
        if t.get("type") == "page" and "1420" in t.get("url", "") and "splash" not in t.get("url",""):
            return t["webSocketDebuggerUrl"]
    return None

def main():
    cmd = sys.argv[1]
    args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    ws_url = shell_ws()
    if not ws_url:
        print("NO_SHELL_TARGET"); sys.exit(2)
    ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=True)
    ws.send(json.dumps({"id":1,"method":"Runtime.enable"}))
    t = time.time()
    while time.time() < t + 1.5:
        try: ws.recv()
        except: break

    # fire-and-forget: kick the invoke, store result on window.__cdp_result
    kick = (
        "window.__cdp_result = undefined; window.__cdp_done = false; "
        "window.__TAURI_INTERNALS__.invoke(" + json.dumps(cmd) + ", " + args + ")"
        ".then(function(r){ window.__cdp_result = r; window.__cdp_done = true; },"
        " function(e){ window.__cdp_result = 'ERR:' + (e && e.message || e); window.__cdp_done = true; });"
        "'kicked'"
    )
    ws.send(json.dumps({"id":2,"method":"Runtime.evaluate",
        "params":{"expression":kick,"returnByValue":True,"awaitPromise":False}}))
    # consume the kicked ack
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            m = json.loads(ws.recv())
            if m.get("id") == 2: break
        except Exception: break

    # poll window.__cdp_done
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(0.4)
        ws.send(json.dumps({"id":3,"method":"Runtime.evaluate",
            "params":{"expression":"JSON.stringify({done:window.__cdp_done, result:window.__cdp_result})",
                      "returnByValue":True,"awaitPromise":False}}))
        got = False
        while time.time() < deadline:
            try:
                m = json.loads(ws.recv())
            except Exception:
                break
            if m.get("id") == 3:
                v = m.get("result",{}).get("result",{}).get("value")
                if v:
                    try:
                        obj = json.loads(v)
                        if obj.get("done"):
                            r = obj.get("result")
                            if isinstance(r, str) and r.startswith("ERR:"):
                                print(r)
                            else:
                                print(json.dumps(r, ensure_ascii=False) if not isinstance(r,str) else r)
                            ws.close(); return
                    except Exception:
                        pass
                got = True; break
        if not got:
            break
    print("TIMEOUT")
    ws.close()

if __name__ == "__main__":
    main()
