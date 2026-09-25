import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / ".cache" / "tizen4-playback-matrix-result.json"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/report":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 256 * 1024:
            self.send_error(413)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(f"MATRIX_RESULT {OUTPUT}", flush=True)
            print(json.dumps(payload), flush=True)
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self.send_error(400, str(error))

    def log_message(self, format, *args):
        print(format % args, flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8091), Handler)
    print("MATRIX_COLLECTOR listening on 0.0.0.0:8091", flush=True)
    server.serve_forever()
