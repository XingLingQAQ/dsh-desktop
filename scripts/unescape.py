#!/usr/bin/env python3
"""Read stdin, unescape the \\uXXXX sequences the CDP probes emit, print utf-8."""
import codecs
import sys

raw = sys.stdin.read()
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
try:
    print(codecs.decode(raw, "unicode_escape"))
except Exception:
    print(raw)
