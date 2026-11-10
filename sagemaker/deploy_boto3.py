"""Deploy a finished SageMaker training job as a serverless endpoint, then test it.

Uses only boto3 (no sagemaker SDK), so it runs on any Python with boto3.

    python sagemaker/deploy_boto3.py                  # newest completed fraud-lgbm-* job
    python sagemaker/deploy_boto3.py --job fraud-lgbm-20261110-080609
    python sagemaker/deploy_boto3.py --test-only      # just send test rows
    python sagemaker/deploy_boto3.py --delete         # remove endpoint + config (model kept)

Test rows come from data/fraudTest.csv (never used for training). Their features are
built exactly like sagemaker/prepare_data.py and the writer Lambda.
"""
import argparse
import csv
from datetime import datetime
import json
import math
from pathlib import Path
import time

import boto3

REGION = "us-east-1"
BUCKET = "fraud-sagemaker-658980432945"
ROLE = "arn:aws:iam::658980432945:role/fraud-sagemaker-training-role"
IMAGE = "683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3"
ENDPOINT = "fraud-detector-serverless"
ROOT = Path(__file__).resolve().parents[1]


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def features(row):
    t = datetime.strptime(row["trans_date_trans_time"], "%Y-%m-%d %H:%M:%S")
    dob = datetime.strptime(row["dob"], "%Y-%m-%d")
    return {
        "hour": t.hour, "weekday": t.weekday(), "age": int((t - dob).days / 365.25),
        "distance_km": haversine_km(float(row["lat"]), float(row["long"]),
                                    float(row["merch_lat"]), float(row["merch_long"])),
        "amt": float(row["amt"]), "category": row["category"], "gender": row["gender"],
        "city_pop": int(row["city_pop"]),
    }


def latest_job(sm):
    jobs = sm.list_training_jobs(NameContains="fraud-lgbm-", StatusEquals="Completed",
                                 SortBy="CreationTime", SortOrder="Descending")["TrainingJobSummaries"]
    if not jobs:
        raise SystemExit("No completed fraud-lgbm-* training job found")
    return jobs[0]["TrainingJobName"]


def deploy(sm, job, memory, concurrency):
    d = sm.describe_training_job(TrainingJobName=job)
    model_data = d["ModelArtifacts"]["S3ModelArtifacts"]
    print("job:", job)
    for m in d.get("FinalMetricDataList", []):
        print(f"  {m['MetricName']} = {m['Value']:.4f}")
    print("model:", model_data)

    model_name, config_name = f"{job}-model", f"{job}-serverless"
    try:
        sm.create_model(
            ModelName=model_name, ExecutionRoleArn=ROLE,
            PrimaryContainer={"Image": IMAGE, "ModelDataUrl": model_data, "Environment": {
                "SAGEMAKER_PROGRAM": "inference.py",
                "SAGEMAKER_SUBMIT_DIRECTORY": f"s3://{BUCKET}/code/sourcedir.tar.gz",
                "SAGEMAKER_REGION": REGION, "SAGEMAKER_CONTAINER_LOG_LEVEL": "20"}},
            Tags=[{"Key": "project", "Value": "credit-card-fraud-detector"}])
        print("created model", model_name)
    except sm.exceptions.ClientError as e:
        if "Cannot create already existing model" not in str(e):
            raise
    try:
        sm.create_endpoint_config(
            EndpointConfigName=config_name,
            ProductionVariants=[{"VariantName": "AllTraffic", "ModelName": model_name,
                                 "ServerlessConfig": {"MemorySizeInMB": memory,
                                                      "MaxConcurrency": concurrency}}],
            Tags=[{"Key": "project", "Value": "credit-card-fraud-detector"}])
        print("created endpoint config", config_name)
    except sm.exceptions.ClientError as e:
        if "Cannot create already existing endpoint configuration" not in str(e):
            raise
    try:
        sm.describe_endpoint(EndpointName=ENDPOINT)
        sm.update_endpoint(EndpointName=ENDPOINT, EndpointConfigName=config_name)
        print("updating endpoint", ENDPOINT)
    except sm.exceptions.ClientError:
        sm.create_endpoint(EndpointName=ENDPOINT, EndpointConfigName=config_name,
                           Tags=[{"Key": "project", "Value": "credit-card-fraud-detector"}])
        print("creating endpoint", ENDPOINT)
    print("waiting for InService (usually 3-6 minutes) ...")
    start = time.time()
    while True:
        e = sm.describe_endpoint(EndpointName=ENDPOINT)
        if e["EndpointStatus"] in ("InService", "Failed"):
            break
        time.sleep(15)
    print(f"status: {e['EndpointStatus']} after {time.time() - start:.0f}s", e.get("FailureReason", ""))
    if e["EndpointStatus"] != "InService":
        raise SystemExit(f"Check logs: aws logs tail /aws/sagemaker/Endpoints/{ENDPOINT} --since 1h")


def test(n_each=3):
    rows, fraud, legit = [], 0, 0
    with open(ROOT / "data" / "fraudTest.csv", newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row["is_fraud"] == "1" and fraud < n_each:
                rows.append(row); fraud += 1
            elif row["is_fraud"] == "0" and legit < n_each:
                rows.append(row); legit += 1
            if fraud >= n_each and legit >= n_each:
                break
    rt = boto3.client("sagemaker-runtime", region_name=REGION)
    body = json.dumps({"instances": [features(r) for r in rows]})
    for attempt in ("first call (may include cold start)", "second call"):
        t0 = time.time()
        resp = rt.invoke_endpoint(EndpointName=ENDPOINT, ContentType="application/json", Body=body)
        scores = json.loads(resp["Body"].read())["scores"]
        print(f"{attempt}: {(time.time() - t0) * 1000:.0f} ms")
    print(f"{'label':>5}  {'score':>7}  amt      category        trans_num")
    for r, s in zip(rows, scores):
        print(f"{r['is_fraud']:>5}  {s:7.4f}  {float(r['amt']):<8.2f} {r['category']:<15} {r['trans_num']}")


def delete(sm):
    e = sm.describe_endpoint(EndpointName=ENDPOINT)
    sm.delete_endpoint(EndpointName=ENDPOINT)
    sm.delete_endpoint_config(EndpointConfigName=e["EndpointConfigName"])
    print("deleted endpoint and config", e["EndpointConfigName"])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--job")
    p.add_argument("--memory", type=int, default=2048)
    p.add_argument("--concurrency", type=int, default=5)
    p.add_argument("--test-only", action="store_true")
    p.add_argument("--delete", action="store_true")
    a = p.parse_args()
    sm = boto3.client("sagemaker", region_name=REGION)
    if a.delete:
        return delete(sm)
    if not a.test_only:
        deploy(sm, a.job or latest_job(sm), a.memory, a.concurrency)
    test()


if __name__ == "__main__":
    main()
