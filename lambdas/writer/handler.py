"""Kinesis-triggered writer Lambda: store, score and alert, one model call per batch.

Per batch:
  1. decode each record and put_pending (conditional: a redelivered event is not duplicated)
  2. build model inputs; a record that can never be scored (bad/missing features) is
     marked ERROR and skipped (retrying it cannot succeed)
  3. score all remaining records with ONE scorer call (SageMaker endpoint or placeholder)
     - call fails -> those records are marked ERROR and returned in batchItemFailures, so
       Kinesis retries them; on success record_score turns ERROR into SCORED
  4. record_score; if flagged and SNS is configured: begin_alert -> publish -> mark_alert_sent
An inference failure is never stored as "not fraud". ground_truth is never used here.
"""

import base64
import json
import logging
import os

import scorer
from db import repository as repo

log = logging.getLogger()
log.setLevel(logging.INFO)

TABLE = os.environ.get("TABLE_NAME", "FraudTransactions")
THRESHOLD = float(os.environ.get("THRESHOLD", "0.5"))
ALERT_TOPIC_ARN = os.environ.get("ALERT_TOPIC_ARN", "")

_ddb = None
_sns = None


def _clients():
    global _ddb, _sns
    if _ddb is None:
        import boto3
        _ddb = boto3.client("dynamodb")
        _sns = boto3.client("sns") if ALERT_TOPIC_ARN else None
    return _ddb, _sns


def _alert_message(tx, fraud_score):
    f = tx["features"]
    return (
        "Suspicious transaction detected (simulated replay data)\n\n"
        f"event_id: {tx['event_id']}\n"
        f"fraud_score: {fraud_score:.3f} (threshold {THRESHOLD})\n"
        f"amount: {f['amount']}  category: {f['category']}  merchant: {f['merchant']}\n"
        f"state: {f['state']}  source_timestamp: {tx['source_timestamp']}\n"
        f"account_id (pseudonym): {tx['account_id']}\n"
    )


def _finish(tx, fraud_score, model_version, ddb, sns):
    _, flagged = repo.record_score(ddb, tx["event_id"], fraud_score, THRESHOLD, model_version,
                                   table=TABLE)
    if flagged and sns is not None and repo.begin_alert(ddb, tx["event_id"], table=TABLE):
        message_id = sns.publish(TopicArn=ALERT_TOPIC_ARN, Subject="Fraud alert (demo)",
                                 Message=_alert_message(tx, fraud_score))["MessageId"]
        repo.mark_alert_sent(ddb, tx["event_id"], message_id, table=TABLE)
    return "flagged" if flagged else "scored"


def _count(counts, key, n=1):
    counts[key] = counts.get(key, 0) + n


def lambda_handler(event, context):
    ddb, sns = _clients()
    failures, counts, ready = [], {}, []

    for record in event.get("Records", []):
        seq = record["kinesis"]["sequenceNumber"]
        try:
            tx = json.loads(base64.b64decode(record["kinesis"]["data"]))
            if tx.get("schema_version") != "1.0":
                raise ValueError(f"unsupported schema_version {tx.get('schema_version')!r}")
            repo.put_pending(ddb, tx, table=TABLE)       # False on redelivery; continue
        except (ValueError, KeyError, TypeError) as exc:  # malformed: can never succeed
            log.error("skipping malformed record %s: %s", seq, exc)
            _count(counts, "malformed")
            continue
        except Exception:
            log.exception("transient failure storing %s; will retry", seq)
            failures.append({"itemIdentifier": seq})
            _count(counts, "retry")
            continue
        try:
            ready.append((seq, tx, scorer.prepare(tx["features"])))
        except (ValueError, KeyError, TypeError) as exc:
            log.error("cannot build model input for %s: %s", tx["event_id"], exc)
            repo.record_error(ddb, tx["event_id"], f"bad model input: {exc}", table=TABLE)
            _count(counts, "error")

    scores, model_version = [], ""
    if ready:
        try:
            scores, model_version = scorer.score_batch([item for _, _, item in ready])
        except Exception as exc:
            log.exception("scoring call failed for %d records; will retry", len(ready))
            for seq, tx, _ in ready:
                try:
                    repo.record_error(ddb, tx["event_id"], f"scoring failed: {exc}", table=TABLE)
                except Exception:
                    log.exception("could not mark %s as ERROR", tx["event_id"])
                failures.append({"itemIdentifier": seq})
            _count(counts, "retry", len(ready))
            ready = []

    for (seq, tx, _), fraud_score in zip(ready, scores):
        try:
            _count(counts, _finish(tx, fraud_score, model_version, ddb, sns))
        except Exception:
            log.exception("transient failure saving %s; will retry", seq)
            failures.append({"itemIdentifier": seq})
            _count(counts, "retry")

    log.info("batch summary: %s", json.dumps({"model_version": model_version, **counts}))
    return {"batchItemFailures": failures}
