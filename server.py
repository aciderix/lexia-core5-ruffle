import http.server
import socketserver
import os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add CORS headers to all responses
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, *')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"[SERVER] http://localhost:{PORT}")
    httpd.serve_forever()
