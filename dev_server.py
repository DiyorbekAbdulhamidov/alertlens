"""Local development server: static files + the same API handler used in production.
Usage: python dev_server.py [port]   then open http://localhost:8000
"""
import sys, os
from http.server import HTTPServer, SimpleHTTPRequestHandler
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server.app import handler as ApiHandler


class H(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/'):
            return ApiHandler.do_GET(self)
        return super().do_GET()

    def do_POST(self):
        return ApiHandler.do_POST(self)

    def do_OPTIONS(self):
        return ApiHandler.do_OPTIONS(self)

    _send = ApiHandler._send


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'AlertLens on http://localhost:{port}')
    HTTPServer(('0.0.0.0', port), H).serve_forever()
