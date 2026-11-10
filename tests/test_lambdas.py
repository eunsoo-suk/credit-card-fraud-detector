import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "lambdas" / "writer"))  # for "import scorer"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


writer = load("writer_handler", ROOT / "lambdas/writer/handler.py")
reader = load("reader_handler", ROOT / "lambdas/reader/handler.py")
import scorer  # noqa: E402
from db import repository as repo  # noqa: E402


class ConditionalCheckFailed(Exception):
    response = {"Error": {"Code": "ConditionalCheckFailedException"}}


def kinesis_event(*transactions, raw=None):
    records = []
    for i, tx in enumerate(transactions):
        data = raw if raw is not None else base64.b64encode(json.dumps(tx).encode()).decode()
        records.append({"kinesis": {"data": data, "sequenceNumber": str(i + 1)}})
    return {"Records": records}


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.tx = json.loads((ROOT / "examples/event.json").read_text())
        self.ddb, self.sns = Mock(), Mock()
        self.sns.publish.return_value = {"MessageId": "m-1"}
        writer._ddb, writer._sns = self.ddb, None
        self._env = dict(os.environ)
        os.environ["SCORER_MODE"] = "placeholder"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        scorer._runtime = None

    def updates(self):
        return [c.kwargs["UpdateExpression"] for c in self.ddb.update_item.call_args_list]

    def other(self, n=2):
        return dict(self.tx, event_id=f"b0000000-0000-0000-0000-00000000000{n}")

    def test_fixture_is_scored_and_stored(self):
        lam = json.loads((ROOT / "examples/lambda_event.json").read_text())
        self.assertEqual(writer.lambda_handler(lam, None), {"batchItemFailures": []})
        self.ddb.put_item.assert_called_once()
        self.assertTrue(any("fraud_score" in u for u in self.updates()))

    def test_placeholder_never_uses_ground_truth(self):
        a = dict(self.tx["features"])
        risky = dict(a, amount=900.0, hour=23, category="shopping_net")
        self.assertGreaterEqual(scorer.placeholder_score(risky), 0.5)
        self.assertLess(scorer.placeholder_score(a), 0.5)

    def test_model_input_matches_sagemaker_contract(self):
        item = scorer.model_input(self.tx["features"])
        self.assertEqual(set(item), {"hour", "weekday", "age", "distance_km", "amt",
                                     "category", "gender", "city_pop"})
        self.assertEqual((item["amt"], item["gender"], item["age"]), (8.5, "F", 30))
        self.assertAlmostEqual(item["distance_km"], 3.63, places=2)
        del self.tx["features"]["gender"]
        with self.assertRaises(ValueError):
            scorer.model_input(self.tx["features"])

    def test_sagemaker_scores_whole_batch_in_one_call(self):
        os.environ.update(SCORER_MODE="sagemaker", SAGEMAKER_ENDPOINT="ep", MODEL_VERSION="m1")
        runtime = Mock()
        runtime.invoke_endpoint.return_value = {"Body": io.BytesIO(b'{"scores": [0.99, 0.01]}')}
        scorer._runtime = runtime
        result = writer.lambda_handler(kinesis_event(self.tx, self.other()), None)
        self.assertEqual(result, {"batchItemFailures": []})
        runtime.invoke_endpoint.assert_called_once()
        body = json.loads(runtime.invoke_endpoint.call_args.kwargs["Body"])
        self.assertEqual(len(body["instances"]), 2)
        self.assertNotIn("ground_truth", json.dumps(body))
        values = [c.kwargs["ExpressionAttributeValues"] for c in self.ddb.update_item.call_args_list]
        self.assertEqual([v[":score"] for v in values if ":score" in v], [{"N": "0.99"}, {"N": "0.01"}])
        self.assertTrue(all(v[":mv"] == {"S": "m1"} for v in values if ":mv" in v))

    def test_endpoint_failure_marks_error_and_retries_batch(self):
        os.environ.update(SCORER_MODE="sagemaker", SAGEMAKER_ENDPOINT="ep")
        scorer._runtime = Mock(invoke_endpoint=Mock(side_effect=RuntimeError("throttled")))
        result = writer.lambda_handler(kinesis_event(self.tx, self.other()), None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "1"},
                                                        {"itemIdentifier": "2"}]})
        self.assertEqual(sum("#st = :error" in u for u in self.updates()), 2)
        self.assertFalse(any("fraud_score" in u for u in self.updates()))

    def test_event_without_model_features_is_error_not_retry(self):
        os.environ.update(SCORER_MODE="sagemaker", SAGEMAKER_ENDPOINT="ep")
        scorer._runtime = Mock()
        del self.tx["features"]["gender"]                       # e.g. an old v1 event
        result = writer.lambda_handler(kinesis_event(self.tx), None)
        self.assertEqual(result, {"batchItemFailures": []})
        scorer._runtime.invoke_endpoint.assert_not_called()
        self.assertTrue(any("#st = :error" in u for u in self.updates()))

    def test_flagged_sends_one_alert_when_sns_configured(self):
        self.tx["features"].update(amount=1500.0, hour=1)
        outcome = writer._finish(self.tx, scorer.placeholder_score(self.tx["features"]),
                                 "v", self.ddb, self.sns)
        self.assertEqual(outcome, "flagged")
        self.sns.publish.assert_called_once()
        self.assertTrue(any("alert_status = :sent" in u for u in self.updates()))

    def test_alert_not_resent_when_already_sent(self):
        def update(**kwargs):
            if "alert_attempts" in kwargs["UpdateExpression"]:
                raise ConditionalCheckFailed()  # alert_status is no longer PENDING
            return {}
        self.ddb.update_item.side_effect = update
        writer._finish(self.tx, 0.97, "v", self.ddb, self.sns)
        self.sns.publish.assert_not_called()

    def test_malformed_record_is_skipped_not_retried(self):
        result = writer.lambda_handler(kinesis_event({}, raw="bm90IGpzb24="), None)
        self.assertEqual(result, {"batchItemFailures": []})
        self.ddb.put_item.assert_not_called()

    def test_transient_failure_reports_only_that_record(self):
        calls = {"n": 0}

        def put(**kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("throttled")
        self.ddb.put_item.side_effect = put
        result = writer.lambda_handler(kinesis_event(self.tx, self.other()), None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "2"}]})


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.ddb = Mock()
        reader._ddb = self.ddb
        tx = json.loads((ROOT / "examples/event.json").read_text())
        self.item = {k: repo.to_attr(v) for k, v in repo.build_pending_item(tx).items()}

    def call(self, path, params=None, method="GET"):
        event = {"rawPath": path, "queryStringParameters": params,
                 "requestContext": {"http": {"method": method}}}
        response = reader.lambda_handler(event, None)
        return response["statusCode"], json.loads(response["body"])

    def test_flagged_with_pagination_token(self):
        key = {"event_id": {"S": "x"}, "flag_status": {"S": "FLAGGED"}, "emitted_at": {"S": "t"}}
        self.ddb.query.return_value = {"Items": [self.item], "LastEvaluatedKey": key}
        status, body = self.call("/transactions/flagged", {"limit": "500"})
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 1)
        self.assertEqual(self.ddb.query.call_args.kwargs["Limit"], 100)  # clamped
        self.ddb.query.return_value = {"Items": []}
        self.call("/transactions/flagged", {"next": body["next"]})
        self.assertEqual(self.ddb.query.call_args.kwargs["ExclusiveStartKey"], key)

    def test_recent_validates_day(self):
        self.assertEqual(self.call("/transactions/recent", {"day": "yesterday"})[0], 400)
        self.ddb.query.return_value = {"Items": [self.item]}
        status, body = self.call("/transactions/recent", {"day": "2026-10-16"})
        self.assertEqual((status, body["items"][0]["status"]), (200, "PENDING"))

    def test_get_one_and_not_found(self):
        self.ddb.get_item.return_value = {"Item": self.item}
        eid = "a3836b30-2a39-543c-a8af-baca7121e670"
        self.assertEqual(self.call(f"/transactions/{eid}")[1]["event_id"], eid)
        self.ddb.get_item.return_value = {}
        self.assertEqual(self.call(f"/transactions/{eid}")[0], 404)

    def test_read_only(self):
        self.assertEqual(self.call("/transactions/flagged", method="POST")[0], 405)
        self.assertEqual(self.call("/nope")[0], 404)
        self.ddb.put_item.assert_not_called()
        self.ddb.update_item.assert_not_called()


class RepositoryAlertTests(unittest.TestCase):
    def test_begin_alert_is_conditional(self):
        ddb = Mock()
        self.assertTrue(repo.begin_alert(ddb, "e1"))
        self.assertEqual(ddb.update_item.call_args.kwargs["ConditionExpression"],
                         "alert_status = :pending")
        ddb.update_item.side_effect = ConditionalCheckFailed()
        self.assertFalse(repo.begin_alert(ddb, "e1"))


if __name__ == "__main__":
    unittest.main()
