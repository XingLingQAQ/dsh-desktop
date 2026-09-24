#!/usr/bin/env python3
"""Probe whether the host can actually stage files, which no amount of reading settled.

The prompt contract carries files as an opaque `receiptId` from a preceding
upload, so the plugin streams each dropped path into `fileUploads.uploadStream`.
That service's presence in the shipped desktop composition could not be confirmed
from source, and the difference between "mounted" and "not mounted" is the
difference between this feature working and answering `unavailable` forever.

This posts a real file to the real route and reports the host's own answer.
"""
import json
import os
import sys
import tempfile
import urllib.request

LIST = "http://127.0.0.1:9222/json"


def host_base():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            u = t.get("url", "")
            if u.startswith("http://127.0.0.1:"):
                return u.split("/?")[0].rstrip("/")
    return None


def post(url, payload, timeout=60):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def make_file(name, body):
    base = os.path.join(tempfile.gettempdir(), "pet-upload-probe")
    os.makedirs(base, exist_ok=True)
    path = os.path.join(base, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return path


def main():
    base = host_base()
    if base is None:
        print("no host")
        return 2
    sessions = json.loads(urllib.request.urlopen(base + "/dsh-desktop-pet/sessions",
                                                 timeout=20).read().decode("utf-8"))
    current = sessions.get("current")
    if not current:
        print("no current session; open one in the app first")
        return 2
    print("session:", current)

    good = make_file("probe-attach.txt", "attached by the pet probe\n" * 20)
    print("file:", good, os.path.getsize(good), "bytes")

    print("\n--- 1. a real file ---")
    print(" ", json.dumps(post(base + "/dsh-desktop-pet/prompt",
                               {"sessionId": current, "text": "probe-upload: 只回复 ok",
                                "files": [good]}), ensure_ascii=False))

    print("\n--- 2. a path that does not exist ---")
    print(" ", json.dumps(post(base + "/dsh-desktop-pet/prompt",
                               {"sessionId": current, "text": "x",
                                "files": [os.path.join(tempfile.gettempdir(), "nope-xyz.txt")]}),
                          ensure_ascii=False))

    print("\n--- 3. a relative path ---")
    print(" ", json.dumps(post(base + "/dsh-desktop-pet/prompt",
                               {"sessionId": current, "text": "x", "files": ["relative.txt"]}),
                          ensure_ascii=False))

    print("\n--- 4. a directory ---")
    print(" ", json.dumps(post(base + "/dsh-desktop-pet/prompt",
                               {"sessionId": current, "text": "x",
                                "files": [tempfile.gettempdir()]}), ensure_ascii=False))

    print("\n--- 5. no files (legacy path, must be unchanged) ---")
    print(" ", json.dumps(post(base + "/dsh-desktop-pet/prompt",
                               {"sessionId": current, "text": "probe-legacy: 只回复 ok"}),
                          ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
