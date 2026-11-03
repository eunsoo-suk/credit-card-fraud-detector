"""Serve the fraud detector dashboard locally, with CloudWatch pipeline metrics.

    python dashboard/serve.py                       # live: reads .local/backend.json
    python dashboard/serve.py --api https://ID.execute-api.us-east-1.amazonaws.com
    python dashboard/serve.py --demo                # synthetic data, no AWS needed

Transactions: the page calls the team's read API (scripts/deploy_backend.py) directly.
Pipeline metrics: /local/metrics is answered by THIS process with YOUR AWS identity
(default boto3 chain, e.g. AWS_PROFILE) and needs only cloudwatch:GetMetricData.
No credentials ever reach the browser. Resource names are read from the files the
deploy scripts already write: .local/backend.json and .local/outputs.json.

Binds to 127.0.0.1 only and never writes to AWS or to the repository.
"""

import argparse
from functools import partial
import http.server
import json
import logging
from pathlib import Path
import posixpath
import sys
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser

import cloudwatch_metrics

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_PORT = 8050
BIND = "127.0.0.1"
METRICS_PATH = "/local/metrics"
PUBLIC_FILES = {"/", "/index.html", "/config.js"}
PUBLIC_DIRS = ("/css/", "/js/")
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
PAGE_PATHS = ("/", "/index.html")

log = logging.getLogger("dashboard")


# ------------------------------------------------------------------ pure helpers
def read_state(local_dir):
    """API URL, region and per-stage resource names from the deploy scripts' outputs."""
    def load(name):
        path = local_dir / name
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable %s: %s", path, exc)
            return {}

    backend, outputs = load("backend.json"), load("outputs.json")
    stream_arn = backend.get("StreamArn") or outputs.get("StreamArn") or ""
    resources = {
        "producer": outputs.get("InstanceId"),
        "kinesis": stream_arn.rsplit("/", 1)[-1] if stream_arn else None,
        "writer": backend.get("WriterFunction"),
        "table": backend.get("Table"),
        "alerts": backend.get("AlertTopicArn"),
        "api": backend.get("ApiId"),
    }
    return {
        "api_url": backend.get("ApiUrl", ""),
        "region": backend.get("Region") or outputs.get("Region"),
        "resources": {stage: name for stage, name in resources.items() if name},
    }


def config_script(api_url, metrics_url):
    """window.FRAUD_DASHBOARD_CONFIG as JavaScript; '<' is escaped so it cannot end a tag."""
    payload = json.dumps({"apiUrl": api_url, "metricsUrl": metrics_url})
    return f"window.FRAUD_DASHBOARD_CONFIG = {payload.replace('<', chr(92) + 'u003c')};\n"


def request_path(raw):
    """Percent-decoded path of a request target; None unless it is a plain absolute path.

    SimpleHTTPRequestHandler decodes %2e%2e itself, so the allowlist must check the
    decoded form too; "//host/..." and absolute-URL targets are refused outright.
    """
    if not raw.startswith("/") or raw.startswith("//"):
        return None
    return unquote(raw.split("?", 1)[0].split("#", 1)[0])


def is_public(path):
    """Only the page and its css/js assets are served (not this script or tests).

    `path` must already be decoded with request_path().
    """
    if path == "/":
        return True
    if "\\" in path or "\x00" in path or "%" in path or posixpath.normpath(path) != path:
        return False  # traversal, odd separators, double encoding, or listings like "/js/"
    return path in PUBLIC_FILES or path.startswith(PUBLIC_DIRS)


def is_cross_site(headers, path):
    """True for requests another website triggered (Fetch Metadata), except opening the page.

    Stops other sites from reading config.js (the API URL) or spending CloudWatch calls.
    Clients that send no Sec-Fetch-Site (curl, older browsers) are not treated as cross-site.
    """
    site = headers.get("Sec-Fetch-Site")
    if site in (None, "same-origin", "none"):
        return False
    return not (headers.get("Sec-Fetch-Mode") == "navigate" and path in PAGE_PATHS)


def is_local_host(host, port):
    """Reject requests whose Host is not this machine (DNS-rebinding protection)."""
    return host in {f"{BIND}:{port}", f"localhost:{port}"}


def valid_api_url(url):
    """Same rules as normalizeApiUrl in js/api.js: https, or http to this machine only."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return False
    if not host or parts.username or parts.password or parts.query or parts.fragment:
        return False
    return parts.scheme == "https" or (parts.scheme == "http" and host in LOCAL_HOSTS)


def csp_header(api_url):
    """Content-Security-Policy that only lets the page call itself and the configured API."""
    parts = urlsplit(api_url)
    api_origin = f" {parts.scheme}://{parts.netloc}" if api_url else ""
    return ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            f"connect-src 'self'{api_origin}; base-uri 'none'; form-action 'none'; "
            "object-src 'none'; frame-ancestors 'none'")


# ------------------------------------------------------------------ HTTP server
class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Content-Security-Policy", self.server.app["csp"])
        super().end_headers()

    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send(self, status, body, content_type):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status, body):
        self._send(status, json.dumps(body, default=str), "application/json")

    def do_HEAD(self):
        self._json(405, {"error": "only GET is supported"})

    def do_GET(self):
        app = self.server.app
        if not is_local_host(self.headers.get("Host"), app["port"]):
            return self._json(403, {"error": "forbidden host"})
        path = request_path(self.path)
        if path is None:
            return self._json(400, {"error": "bad request target"})
        if is_cross_site(self.headers, path):
            return self._json(403, {"error": "cross-site request refused"})
        if path == "/config.js":
            return self._send(200, config_script(app["api_url"], app["metrics_url"]),
                              "text/javascript; charset=utf-8")
        if path == METRICS_PATH:
            return self._metrics(app, parse_qs(urlsplit(self.path).query))
        if not is_public(path):
            return self._json(404, {"error": "not found"})
        return super().do_GET()

    def _metrics(self, app, query):
        if app["cloudwatch"] is None:
            return self._json(404, {"error": "CloudWatch metrics are not enabled"})
        try:
            hours = int(query.get("hours", ["3"])[0])
        except ValueError:
            return self._json(400, {"error": "hours must be an integer"})
        try:
            body = cloudwatch_metrics.collect(app["cloudwatch"], app["resources"], hours)
        except Exception as exc:  # report the AWS error code locally, not a stack trace
            code = getattr(exc, "response", {}).get("Error", {}).get("Code", type(exc).__name__)
            log.exception("CloudWatch request failed")
            return self._json(502, {"error": f"CloudWatch request failed ({code})"})
        return self._json(200, body)


def cloudwatch_client(region):
    """boto3 CloudWatch client for the caller's identity, or None (metrics disabled)."""
    try:
        import boto3
        session = boto3.Session(region_name=region) if region else boto3.Session()
        identity = session.client("sts").get_caller_identity()["Arn"]
    except Exception as exc:
        print(f"CloudWatch metrics disabled: no usable AWS identity ({exc}).")
        return None
    print(f"CloudWatch metrics as {identity} in {session.region_name}")
    return session.client("cloudwatch")


def build_app(args):
    state = read_state(Path(args.local_dir))
    api_url = "" if args.demo else (args.api or state["api_url"]).rstrip("/")
    if api_url and not valid_api_url(api_url):
        sys.exit(f"API URL must be https:// (or http://localhost), without credentials or query "
                 f"(got {api_url!r})")
    if not args.demo and not api_url:
        print("No API URL found in .local/backend.json and no --api given: showing DEMO data.")
    resources = dict(state["resources"])
    if args.sagemaker_endpoint:
        resources["model"] = args.sagemaker_endpoint
    client = None
    if api_url and resources and not args.no_metrics:
        client = cloudwatch_client(args.region or state["region"])
    return {"port": args.port, "api_url": api_url, "resources": resources, "cloudwatch": client,
            "metrics_url": METRICS_PATH if client else "", "csp": csp_header(api_url)}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", help="read API base URL (default: ApiUrl in .local/backend.json)")
    parser.add_argument("--demo", action="store_true", help="synthetic data, no AWS calls")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--region", help="CloudWatch region (default: from .local files)")
    parser.add_argument("--sagemaker-endpoint", help="also chart this SageMaker endpoint")
    parser.add_argument("--no-metrics", action="store_true", help="skip CloudWatch charts")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--local-dir", default=str(ROOT / ".local"),
                        help="where backend.json / outputs.json live")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    app = build_app(args)
    handler = partial(DashboardHandler, directory=str(HERE))
    server = http.server.ThreadingHTTPServer((BIND, args.port), handler)
    server.app = app
    url = f"http://{BIND}:{args.port}/"
    mode = "live" if app["api_url"] else "demo"
    print(f"Dashboard ({mode}) at {url}  -  Ctrl+C to stop")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
