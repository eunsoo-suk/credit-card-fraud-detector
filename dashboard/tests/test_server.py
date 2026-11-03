"""Offline tests for the dashboard's local server and CloudWatch collector.

Run from the repository root:  python -m unittest discover -s dashboard/tests
"""

from datetime import datetime, timezone
from functools import partial
import http.server
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock

DASHBOARD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DASHBOARD))
import cloudwatch_metrics as cw  # noqa: E402
import serve  # noqa: E402

NOW = datetime(2026, 11, 1, 12, 0, 30, tzinfo=timezone.utc)
BASIC = {"kinesis": "fraud-stream", "writer": "fraud-writer", "table": "FraudTransactions"}


def queries(client):
    return client.get_metric_data.call_args.kwargs["MetricDataQueries"]


def dims(query):
    metric = query["MetricStat"]["Metric"]
    return metric["Namespace"], {d["Name"]: d["Value"] for d in metric["Dimensions"]}


class CollectTests(unittest.TestCase):
    def setUp(self):
        cw.clear_cache()
        self.client = Mock()
        self.client.get_metric_data.return_value = {"MetricDataResults": []}

    def test_only_configured_stages_are_queried(self):
        body = cw.collect(self.client, BASIC, hours=3, now=NOW)
        namespaces = {dims(q)[0] for q in queries(self.client)}
        self.assertEqual(namespaces, {"AWS/Kinesis", "AWS/Lambda", "AWS/DynamoDB"})
        self.assertEqual(body["stages"], BASIC)

    def test_every_stage_with_full_config(self):
        resources = dict(BASIC, producer="i-123", model="fraud-detector-serverless",
                         alerts="arn:aws:sns:us-east-1:111122223333:fraud-alerts", api="abc123")
        body = cw.collect(self.client, resources, hours=3, now=NOW)
        self.assertEqual(body["stages"]["alerts"], "fraud-alerts")
        found = [dims(q) for q in queries(self.client)]
        self.assertIn(("AWS/SNS", {"TopicName": "fraud-alerts"}), found)
        self.assertIn(("AWS/ApiGateway", {"ApiId": "abc123"}), found)
        self.assertIn(("AWS/EC2", {"InstanceId": "i-123"}), found)
        self.assertIn(("AWS/SageMaker", {"EndpointName": "fraud-detector-serverless",
                                         "VariantName": "AllTraffic"}), found)
        ids = [q["Id"] for q in queries(self.client)]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(i[0].islower() and i.isalnum() for i in ids))

    def test_points_are_ascending_and_keyed_by_series(self):
        def fake(**kwargs):
            first = kwargs["MetricDataQueries"][0]["Id"]
            return {"MetricDataResults": [{
                "Id": first,
                "Timestamps": [datetime(2026, 11, 1, 11, 59, tzinfo=timezone.utc),
                               datetime(2026, 11, 1, 11, 58, tzinfo=timezone.utc)],
                "Values": [7.0, 5.0]}]}
        self.client.get_metric_data.side_effect = fake
        series = cw.collect(self.client, BASIC, hours=3, now=NOW)["series"]
        incoming = series["kinesis.incoming_records"]
        self.assertEqual((incoming["unit"], incoming["stat"]), ("Count", "Sum"))
        self.assertEqual([p[1] for p in incoming["points"]], [5.0, 7.0])
        self.assertTrue(incoming["points"][0][0].startswith("2026-11-01T11:58"))

    def test_pagination_is_followed(self):
        self.client.get_metric_data.side_effect = [
            {"MetricDataResults": [], "NextToken": "page2"}, {"MetricDataResults": []}]
        cw.collect(self.client, BASIC, hours=3, now=NOW)
        self.assertEqual(self.client.get_metric_data.call_count, 2)
        self.assertEqual(self.client.get_metric_data.call_args.kwargs["NextToken"], "page2")

    def test_period_window_and_clamping(self):
        short = cw.collect(self.client, BASIC, hours=1, now=NOW)
        self.assertEqual(short["period"], 60)
        self.assertEqual(short["end"], "2026-11-01T12:00:00+00:00")  # aligned to period
        cw.clear_cache()
        long = cw.collect(self.client, BASIC, hours=500, now=NOW)
        self.assertEqual((long["hours"], long["period"]), (24, 300))
        call = self.client.get_metric_data.call_args.kwargs
        self.assertEqual(call["ScanBy"], "TimestampAscending")
        self.assertEqual((call["EndTime"] - call["StartTime"]).total_seconds(), 24 * 3600)

    def test_results_are_cached_briefly(self):
        cw.collect(self.client, BASIC, hours=3, now=NOW)
        cw.collect(self.client, BASIC, hours=3, now=NOW)
        self.assertEqual(self.client.get_metric_data.call_count, 1)
        cw.collect(self.client, BASIC, hours=12, now=NOW)
        self.assertEqual(self.client.get_metric_data.call_count, 2)

    def test_nothing_configured_makes_no_call(self):
        body = cw.collect(self.client, {}, hours=3, now=NOW)
        self.assertEqual(body["series"], {})
        self.client.get_metric_data.assert_not_called()

    def test_demo_catalog_matches_cloudwatch_catalog(self):
        """js/demo.js mirrors CATALOG so demo charts use the live keys, stats and units."""
        import re
        source = (DASHBOARD / "js" / "demo.js").read_text(encoding="utf-8")
        demo = {key: (stat, unit) for key, stat, unit in
                re.findall(r'"([a-z]+\.[a-z0-9_]+)": \["(\w+)", "(\w+)"', source)}
        live = {key: (entry[1], entry[2]) for key, entry in cw.CATALOG.items()}
        self.assertEqual(demo, live)


class StateFileTests(unittest.TestCase):
    def test_resources_come_from_deploy_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp)
            (local / "backend.json").write_text(json.dumps({
                "ApiUrl": "https://abc.execute-api.us-east-1.amazonaws.com", "ApiId": "abc",
                "Table": "FraudTransactions", "WriterFunction": "fraud-writer",
                "StreamArn": "arn:aws:kinesis:us-east-1:111122223333:stream/fraud-ingestion-stream",
                "AlertTopicArn": "", "Region": "us-east-1"}))
            (local / "outputs.json").write_text(json.dumps({"InstanceId": "i-9"}))
            state = serve.read_state(local)
        self.assertEqual(state["api_url"], "https://abc.execute-api.us-east-1.amazonaws.com")
        self.assertEqual(state["region"], "us-east-1")
        self.assertEqual(state["resources"], {
            "producer": "i-9", "kinesis": "fraud-ingestion-stream", "writer": "fraud-writer",
            "table": "FraudTransactions", "api": "abc"})

    def test_missing_files_mean_demo(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = serve.read_state(Path(tmp))
        self.assertEqual(state, {"api_url": "", "region": None, "resources": {}})

    def test_config_script_is_safe_json(self):
        script = serve.config_script("https://x.example/</script><script>", "/local/metrics")
        self.assertNotIn("</script>", script)
        self.assertTrue(script.startswith("window.FRAUD_DASHBOARD_CONFIG = "))

    def test_only_dashboard_assets_are_served(self):
        self.assertTrue(serve.is_public("/"))
        self.assertTrue(serve.is_public("/js/main.js"))
        self.assertTrue(serve.is_public("/css/dashboard.css"))
        self.assertFalse(serve.is_public("/serve.py"))
        self.assertFalse(serve.is_public("/tests/test_server.py"))
        self.assertFalse(serve.is_public("/js/../serve.py"))

    def test_host_header_must_be_local(self):
        self.assertTrue(serve.is_local_host("127.0.0.1:8050", 8050))
        self.assertTrue(serve.is_local_host("localhost:8050", 8050))
        self.assertFalse(serve.is_local_host("evil.example:8050", 8050))
        self.assertFalse(serve.is_local_host(None, 8050))


class RequestHardeningTests(unittest.TestCase):
    """Findings from the ECC security review (encoded traversal, cross-site reads)."""

    def public(self, raw):
        path = serve.request_path(raw)
        return path is not None and serve.is_public(path)

    def test_encoded_traversal_is_rejected(self):
        self.assertFalse(self.public("/js/%2e%2e/serve.py"))
        self.assertFalse(self.public("/js/..%2fcloudwatch_metrics.py"))
        self.assertFalse(self.public("/css/%2E%2E/tests/test_server.py"))
        self.assertFalse(self.public("/js/%5c..%5cserve.py"))
        self.assertTrue(self.public("/js/main.js?v=1#x"))

    def test_scheme_relative_targets_are_rejected(self):
        self.assertIsNone(serve.request_path("//js/css/%2e%2e"))
        self.assertIsNone(serve.request_path("http://127.0.0.1:8050/js/main.js"))

    def test_cross_site_subresources_are_rejected(self):
        self.assertTrue(serve.is_cross_site({"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"},
                                            "/config.js"))
        self.assertTrue(serve.is_cross_site({"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors"},
                                            "/local/metrics"))
        self.assertFalse(serve.is_cross_site({"Sec-Fetch-Site": "same-origin"}, "/config.js"))
        self.assertFalse(serve.is_cross_site({"Sec-Fetch-Site": "none"}, "/"))
        self.assertFalse(serve.is_cross_site({}, "/config.js"))  # curl / older browsers
        # following a link to the dashboard from another site still opens the page
        self.assertFalse(serve.is_cross_site({"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"}, "/"))

    def test_api_url_validation_matches_the_browser(self):
        self.assertTrue(serve.valid_api_url("https://abc.execute-api.us-east-1.amazonaws.com"))
        self.assertTrue(serve.valid_api_url("http://127.0.0.1:8060"))
        self.assertFalse(serve.valid_api_url("http://localhost.evil.com"))
        self.assertFalse(serve.valid_api_url("https://u:p@example.com"))
        self.assertFalse(serve.valid_api_url("https://example.com/?q=1"))

    def test_csp_header_only_allows_the_configured_api(self):
        csp = serve.csp_header("https://abc.execute-api.us-east-1.amazonaws.com")
        self.assertIn("connect-src 'self' https://abc.execute-api.us-east-1.amazonaws.com", csp)
        self.assertIn("script-src 'self'", csp)
        self.assertIn("connect-src 'self';", serve.csp_header(""))


class LiveServerTests(unittest.TestCase):
    """Raw HTTP against a real server on a free port, so stray body bytes are visible."""

    def setUp(self):
        handler = partial(serve.DashboardHandler, directory=str(DASHBOARD))
        self.server = http.server.ThreadingHTTPServer((serve.BIND, 0), handler)
        self.port = self.server.server_address[1]
        self.server.app = {"port": self.port, "api_url": "", "resources": {}, "cloudwatch": None,
                           "metrics_url": "", "csp": serve.csp_header("")}
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def raw(self, method, path="/"):
        with socket.create_connection((serve.BIND, self.port), timeout=5) as sock:
            sock.sendall(f"{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
            data = b"".join(iter(lambda: sock.recv(65536), b""))
        head, _, body = data.partition(b"\r\n\r\n")
        return head.decode("latin-1"), body

    def test_head_is_refused_without_a_body(self):
        head, body = self.raw("HEAD")
        self.assertTrue(head.startswith("HTTP/1.0 405"), head)
        self.assertIn("Allow: GET", head)
        self.assertEqual(body, b"")

    def test_get_still_serves_the_page(self):
        head, body = self.raw("GET")
        self.assertTrue(head.startswith("HTTP/1.0 200"), head)
        self.assertIn(b"<title>Fraud Detector Console</title>", body)


if __name__ == "__main__":
    unittest.main()
