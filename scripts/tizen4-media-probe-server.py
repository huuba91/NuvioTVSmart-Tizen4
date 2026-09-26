import argparse
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")


class ProbeHandler(BaseHTTPRequestHandler):
    root = Path.cwd()

    def _resolve_file(self):
        relative = unquote(urlsplit(self.path).path).lstrip("/")
        if not relative or "/" in relative or "\\" in relative:
            return None
        candidate = (self.root / relative).resolve()
        return candidate if candidate.parent == self.root and candidate.is_file() else None

    def _serve(self, include_body):
        file_path = self._resolve_file()
        if not file_path:
            self.send_error(404)
            return

        size = file_path.stat().st_size
        start = 0
        end = size - 1
        status = 200
        range_header = self.headers.get("Range", "").strip()
        if range_header:
            match = RANGE_PATTERN.fullmatch(range_header)
            if not match or (not match.group(1) and not match.group(2)):
                self.send_error(416)
                return
            if match.group(1):
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else end
            else:
                suffix = int(match.group(2))
                start = max(0, size - suffix)
            end = min(end, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if not include_body:
            return
        with file_path.open("rb") as media:
            media.seek(start)
            remaining = length
            while remaining:
                chunk = media.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_HEAD(self):
        self._serve(False)

    def do_GET(self):
        self._serve(True)

    def log_message(self, fmt, *args):
        print(f"{self.client_address[0]} range={self.headers.get('Range', '-')} {fmt % args}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Range-correct server for controlled Tizen media probes")
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    ProbeHandler.root = args.root.resolve()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), ProbeHandler)
    print(f"TIZEN4_MEDIA_PROBE listening on 0.0.0.0:{args.port} root={ProbeHandler.root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
