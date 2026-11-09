from datetime import datetime, timedelta, timezone
import threading
import time

MAX_HOURS = 24
SHORT_WINDOW_HOURS = 3
SHORT_PERIOD = 60
LONG_PERIOD = 300
CACHE_SECONDS = 60

STAGES = {
    "producer": ("AWS/EC2", "InstanceId"),
    "kinesis": ("AWS/Kinesis", "StreamName"),
    "writer": ("AWS/Lambda", "FunctionName"),
    "model": ("AWS/SageMaker", "EndpointName"),
    "table": ("AWS/DynamoDB", "TableName"),
    "alerts": ("AWS/SNS", "TopicName"),
    "api": ("AWS/ApiGateway", "ApiId"),
}
EXTRA_DIMENSIONS = {"model": {"VariantName": "AllTraffic"}}

CATALOG = {
    "producer.cpu": ("CPUUtilization", "Average", "Percent", "Producer CPU"),
    "kinesis.incoming_records": ("IncomingRecords", "Sum", "Count", "Records in"),
    "kinesis.iterator_age": ("GetRecords.IteratorAgeMilliseconds", "Maximum", "Milliseconds",
                             "Stream iterator age"),
    "kinesis.write_throttled": ("WriteProvisionedThroughputExceeded", "Sum", "Count",
                                "Write throttles"),
    "kinesis.read_throttled": ("ReadProvisionedThroughputExceeded", "Sum", "Count",
                               "Read throttles"),
    "writer.invocations": ("Invocations", "Sum", "Count", "Invocations"),
    "writer.errors": ("Errors", "Sum", "Count", "Errors"),
    "writer.throttles": ("Throttles", "Sum", "Count", "Throttles"),
    "writer.duration_avg": ("Duration", "Average", "Milliseconds", "Duration (avg)"),
    "writer.duration_max": ("Duration", "Maximum", "Milliseconds", "Duration (max)"),
    "writer.iterator_age": ("IteratorAge", "Maximum", "Milliseconds", "Lambda iterator age"),
    "model.invocations": ("Invocations", "Sum", "Count", "Invocations"),
    "model.latency": ("ModelLatency", "Average", "Microseconds", "Model latency"),
    "model.errors_4xx": ("Invocation4XXErrors", "Sum", "Count", "4xx errors"),
    "model.errors_5xx": ("Invocation5XXErrors", "Sum", "Count", "5xx errors"),
    "table.write_units": ("ConsumedWriteCapacityUnits", "Sum", "Count", "Write units"),
    "table.read_units": ("ConsumedReadCapacityUnits", "Sum", "Count", "Read units"),
    "table.write_throttles": ("WriteThrottleEvents", "Sum", "Count", "Write throttles"),
    "table.read_throttles": ("ReadThrottleEvents", "Sum", "Count", "Read throttles"),
    "alerts.published": ("NumberOfMessagesPublished", "Sum", "Count", "Published"),
    "alerts.delivered": ("NumberOfNotificationsDelivered", "Sum", "Count", "Delivered"),
    "alerts.failed": ("NumberOfNotificationsFailed", "Sum", "Count", "Failed"),
    "api.requests": ("Count", "Sum", "Count", "Requests"),
    "api.errors_4xx": ("4xx", "Sum", "Count", "4xx"),
    "api.errors_5xx": ("5xx", "Sum", "Count", "5xx"),
    "api.latency": ("Latency", "Average", "Milliseconds", "Latency"),
}

_cache = {}
_lock = threading.Lock()


def clear_cache():
    _cache.clear()


def stage_dimensions(resources):
    stages = {}
    for stage, (_, dimension) in STAGES.items():
        resource = resources.get(stage)
        if not resource:
            continue
        if stage == "alerts":
            resource = resource.rsplit(":", 1)[-1]
        stages[stage] = (resource, {dimension: resource, **EXTRA_DIMENSIONS.get(stage, {})})
    return stages


def _window(hours, now):
    period = SHORT_PERIOD if hours <= SHORT_WINDOW_HOURS else LONG_PERIOD
    epoch = int(now.timestamp())
    end = datetime.fromtimestamp(epoch - epoch % period, tz=timezone.utc)
    return period, end - timedelta(hours=hours), end


def _queries(stages, period):
    queries, keys = [], {}
    for index, (key, (name, stat, _, _)) in enumerate(CATALOG.items()):
        stage = key.split(".")[0]
        if stage not in stages:
            continue
        query_id = f"m{index}"
        keys[query_id] = key
        queries.append({
            "Id": query_id,
            "MetricStat": {
                "Metric": {"Namespace": STAGES[stage][0], "MetricName": name,
                           "Dimensions": [{"Name": k, "Value": v}
                                          for k, v in stages[stage][1].items()]},
                "Period": period,
                "Stat": stat,
            },
            "ReturnData": True,
        })
    return queries, keys


def _fetch(client, queries, start, end):
    params = {"MetricDataQueries": queries, "StartTime": start, "EndTime": end,
              "ScanBy": "TimestampAscending"}
    results = []
    while True:
        response = client.get_metric_data(**params)
        results.extend(response.get("MetricDataResults", []))
        token = response.get("NextToken")
        if not token:
            return results
        params = dict(params, NextToken=token)


def _series(results, keys):
    series = {}
    for key in keys.values():
        _, stat, unit, label = CATALOG[key]
        series[key] = {"stage": key.split(".")[0], "label": label, "stat": stat, "unit": unit,
                       "points": []}
    for result in results:
        key = keys.get(result.get("Id"))
        if key is None:
            continue
        pairs = zip(result.get("Timestamps", []), result.get("Values", []))
        series[key]["points"].extend([ts.isoformat(), value] for ts, value in pairs)
    for entry in series.values():
        entry["points"].sort(key=lambda point: point[0])
    return series


def collect(client, resources, hours, now=None):
    now = now or datetime.now(timezone.utc)
    hours = max(1, min(int(hours), MAX_HOURS))
    period, start, end = _window(hours, now)
    stages = stage_dimensions(resources)
    cache_key = (hours, tuple(sorted((k, v[0]) for k, v in stages.items())))
    with _lock:
        cached = _cache.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        queries, keys = _queries(stages, period)
        results = _fetch(client, queries, start, end) if queries else []
        body = {
            "hours": hours,
            "period": period,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "stages": {stage: resource for stage, (resource, _) in stages.items()},
            "series": _series(results, keys),
        }
        _cache[cache_key] = (time.monotonic() + CACHE_SECONDS, body)
        return body
