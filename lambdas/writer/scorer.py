"""Fraud scoring for the writer Lambda.

SCORER_MODE=sagemaker: one call per Kinesis batch to the serverless endpoint in
  SAGEMAKER_ENDPOINT (sagemaker/README.md, "Integration contract"):
    request  {"instances": [{hour, weekday, age, distance_km, amt, category, gender, city_pop}, ...]}
    response {"scores": [0.98, ...]}       one score per instance, same order
  model_input() turns an event's features (docs/event_schema.json, feature v2) into
  those eight fields exactly as sagemaker/prepare_data.py did for training.
SCORER_MODE=placeholder (default): rule-based stand-in so the pipeline runs without
  a model. Uses only features, never ground_truth. Not a model; never report it.
"""

import json
import math
import os

PLACEHOLDER_VERSION = "placeholder-rules-v0"
_NIGHT_HOURS = {22, 23, 0, 1, 2, 3}
_ONLINE_CATEGORIES = {"shopping_net", "misc_net", "grocery_pos"}
_runtime = None


def mode():
    return os.environ.get("SCORER_MODE", "placeholder")


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def model_input(features):
    """Event features (v2) -> the eight model features. Raises on missing/invalid input."""
    missing = [k for k in ("hour", "weekday", "age_at_transaction", "amount", "category",
                           "gender", "city_population", "customer_lat", "customer_lon",
                           "merchant_lat", "merchant_lon") if features.get(k) in (None, "")]
    if missing:
        raise ValueError(f"missing features for the model: {missing}")
    return {
        "hour": int(features["hour"]),
        "weekday": int(features["weekday"]),
        "age": int(features["age_at_transaction"]),
        "distance_km": haversine_km(float(features["customer_lat"]), float(features["customer_lon"]),
                                    float(features["merchant_lat"]), float(features["merchant_lon"])),
        "amt": float(features["amount"]),            # raw amount, never log-transformed
        "category": str(features["category"]),
        "gender": str(features["gender"]),
        "city_pop": int(features["city_population"]),
    }


def prepare(features):
    """Per-record input for score_batch(); raises ValueError for a record that can never score."""
    return model_input(features) if mode() == "sagemaker" else dict(features)


def placeholder_score(features):
    score = 0.02
    amount = float(features["amount"])
    if amount > 1000:
        score += 0.5
    elif amount > 500:
        score += 0.35
    elif amount > 200:
        score += 0.1
    if int(features["hour"]) in _NIGHT_HOURS:
        score += 0.3
    if features["category"] in _ONLINE_CATEGORIES:
        score += 0.1
    return round(min(score, 0.99), 4)


def _sagemaker_scores(instances):
    global _runtime
    if _runtime is None:
        import boto3
        from botocore.config import Config
        _runtime = boto3.client("sagemaker-runtime", config=Config(
            read_timeout=30, retries={"max_attempts": 3, "mode": "standard"}))
    response = _runtime.invoke_endpoint(
        EndpointName=os.environ["SAGEMAKER_ENDPOINT"],
        ContentType="application/json",
        Body=json.dumps({"instances": instances}),
    )
    scores = json.loads(response["Body"].read())["scores"]
    if len(scores) != len(instances):
        raise ValueError(f"expected {len(instances)} scores, got {len(scores)}")
    return [float(s) for s in scores]


def score_batch(items):
    """Score prepared items in one call. Returns (scores, model_version); raises on failure."""
    if not items:
        return [], ""
    if mode() == "sagemaker":
        version = os.environ.get("MODEL_VERSION") or os.environ["SAGEMAKER_ENDPOINT"]
        return _sagemaker_scores(items), version
    return [placeholder_score(i) for i in items], PLACEHOLDER_VERSION


def score(features):
    """Single-transaction convenience wrapper: (score, model_version)."""
    scores, version = score_batch([prepare(features)])
    return scores[0], version
