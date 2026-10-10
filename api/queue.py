"""Vercel entry point for /api/queue — all logic lives in server/app.py."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from server.app import handler  # noqa: E402,F401
