#!/usr/bin/env python3
"""Report the DSH page's subresource URLs, longest first.

The app boots by loading plugin bundles through a single `/plugins/??a,b,c…`
URL, and the browser refuses to *send* a request whose headers exceed roughly
2 KB — its own baseline headers use most of that. When enough plugins are
installed, that one URL crosses the line and the whole page fails with a 431
before any application code runs.

The token is read from the running page rather than passed in, because it is
minted per launch and a stale one just redirects to a 401.
"""
import json
import re
import urllib.request

LIST = "http://127.0.0.1:9222/json"


def page_url():
    with urllib.request.urlopen(LIST, timeout=5) as r:
        for t in json.load(r):
            u = t.get("url", "")
            if "token=" in u:
                return u
    return None


def main():
    url = page_url()
    if url is None:
        print("no DSH page target")
        return 2
    print("page:", url[:70], "...")
    with urllib.request.urlopen(url, timeout=20) as r:
        html = r.read().decode("utf-8", "replace")
    print("page bytes:", len(html))
    if "431" in html[:400]:
        print("!! the page itself is an error page")
    found = sorted(re.findall(r'(?:src|href)="([^"]+)"', html), key=len, reverse=True)
    print("subresources:", len(found))
    for u in found[:8]:
        print(f"  {len(u):5d}  {u[:120]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
