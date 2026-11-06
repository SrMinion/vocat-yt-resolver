#!/usr/bin/env python3
"""Optional YouTube resolver for a Cloudflare Worker.

Use only for content you are authorized to access and retransmit.
"""
import hmac, json, os, re, select, subprocess, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
KEY = os.environ.get("YT_KEY", "")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8787"))
YTDLP = os.environ.get("YTDLP", "/usr/local/bin/yt-dlp")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
COOKIES = os.environ.get("YT_COOKIES", "")
MAX_STREAMS = int(os.environ.get("MAX_STREAMS", "1"))
START_TIMEOUT = float(os.environ.get("START_TIMEOUT", "15"))
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "0"))
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
FMT_COPY = "140/bestaudio[acodec^=mp4a]"
FMT_ANY = "bestaudio/best"
_sem = threading.BoundedSemaphore(MAX_STREAMS)

def ytdlp_base():
    cmd = [YTDLP, "--no-warnings", "--no-playlist", "--js-runtimes", "node"]
    if COOKIES and os.path.exists(COOKIES):
        cmd += ["--cookies", COOKIES]
    return cmd

def start(vid, fmt, copy):
    args = ["-q", "-f", fmt, "-o", "-", f"https://www.youtube.com/watch?v={vid}"]
    if MAX_SECONDS > 0:
        args += ["--downloader-args", f"http:--timeout {MAX_SECONDS}"]
    y = subprocess.Popen(ytdlp_base() + args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    codec = ["-c:a", "copy"] if copy else ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"]
    f = subprocess.Popen([FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-vn", *codec,
                          "-flush_packets", "1", "-f", "adts", "pipe:1"],
                         stdin=y.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    y.stdout.close()
    ready, _, _ = select.select([f.stdout], [], [], START_TIMEOUT)
    first = f.stdout.read(4096) if ready else b""
    return y, f, first

def kill(*procs):
    for p in procs:
        if p:
            if p.poll() is None:
                p.kill()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a):
        pass
    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def _authed(self):
        got = self.headers.get("authorization", "")
        return bool(KEY) and hmac.compare_digest(got, f"Bearer {KEY}")
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._json(200, {"ok": True, "service": "vocat-yt-resolver"})
        if not self._authed():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        if u.path == "/resolve":
            vid = q.get("id", [""])[0]
            if not ID_RE.match(vid):
                return self._json(400, {"ok": False, "error": "bad_id"})
            return self.resolve(vid)
        if u.path == "/search":
            term = q.get("q", [""])[0].strip()
            if len(term) < 2 or len(term) > 160:
                return self._json(400, {"ok": False, "error": "bad_query"})
            return self.search(term)
        m = re.match(r"^/yt/([A-Za-z0-9_-]{11})\.aac$", u.path)
        if m:
            return self.stream(m.group(1))
        return self._json(404, {"ok": False, "error": "not_found"})
    def resolve(self, vid):
        try:
            r = subprocess.run(ytdlp_base() + ["--simulate", "--print", "format_id",
                "-f", FMT_COPY + "/" + FMT_ANY,
                f"https://www.youtube.com/watch?v={vid}"],
                capture_output=True, text=True, timeout=40)
        except subprocess.TimeoutExpired:
            return self._json(504, {"ok": False, "error": "timeout"})
        out = (r.stdout or "").strip().splitlines()
        if r.returncode == 0 and out:
            return self._json(200, {"ok": True, "format": out[-1]})
        err = (r.stderr or "erro").strip().splitlines()
        return self._json(502, {"ok": False, "error": (err[-1] if err else "erro")[:200]})
    def search(self, term):
        try:
            r = subprocess.run(
                ytdlp_base() + ["--flat-playlist", "--dump-single-json", f"ytsearch5:{term}"],
                capture_output=True, text=True, timeout=40)
        except subprocess.TimeoutExpired:
            return self._json(504, {"ok": False, "error": "timeout"})
        if r.returncode != 0:
            err = (r.stderr or "erro").strip().splitlines()
            return self._json(502, {"ok": False, "error": (err[-1] if err else "erro")[:200]})
        try:
            data = json.loads(r.stdout)
            entries = data.get("entries") or []
            items = [{"id": x.get("id"), "title": x.get("title"),
                      "channel": x.get("channel") or x.get("uploader"),
                      "duration": x.get("duration")}
                     for x in entries if ID_RE.match(x.get("id", ""))]
            return self._json(200, {"ok": True, "query": term, "items": items})
        except (json.JSONDecodeError, AttributeError, TypeError):
            return self._json(502, {"ok": False, "error": "invalid_search_response"})
    def stream(self, vid):
        if not _sem.acquire(blocking=False):
            return self._json(503, {"ok": False, "error": "busy"})
        y = f = None
        try:
            y, f, first = start(vid, FMT_COPY, True)
            if not first:
                kill(f, y)
                y, f, first = start(vid, FMT_ANY, False)
            if not first:
                return self._json(502, {"ok": False, "error": "no_audio"})
            self.send_response(200)
            self.send_header("content-type", "audio/aac")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(first)
            while True:
                chunk = f.stdout.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            kill(f, y)
            _sem.release()

if __name__ == "__main__":
    if not KEY:
        raise SystemExit("defina YT_KEY")
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
