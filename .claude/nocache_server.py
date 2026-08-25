"""Dev-only static file server for previewing public/ with caching disabled.
Plain http.server lets browsers cache JS/CSS aggressively across reloads,
which is confusing during active development. Not part of the shipped app.
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = lambda *a, **kw: NoCacheHandler(*a, directory=directory, **kw)
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
