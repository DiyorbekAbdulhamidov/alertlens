"""Vercel entry point for /api/metrics. All logic lives in server/app.py."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from server.app import handler as _AlertLensHandler  # noqa: E402


class handler(_AlertLensHandler):
    pass
