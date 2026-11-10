"""Build train.parquet / val.parquet for sagemaker/src/train.py from fraudTrain.csv.

The eight model features follow the integration contract in sagemaker/README.md and
must match the writer Lambda's feature code (lambdas/writer/scorer.py) exactly:
  hour, weekday      from trans_date_trans_time (naive source timestamp, Monday = 0)
  age                int((t - dob).days / 365.25)
  distance_km        haversine between (lat, long) and (merch_lat, merch_long)
  amt                raw amount (not log-transformed)
  category, gender   plain text -> pandas category
  city_pop           int
The last 20% of rows by time become val.parquet (early stopping only).
fraudTest.csv is never used here; it stays the untouched holdout / replay stream.

    python sagemaker/prepare_data.py --csv data/fraudTrain.csv --out data
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

FEATURES = ["hour", "weekday", "age", "distance_km", "amt", "category", "gender", "city_pop"]
LABEL = "is_fraud"


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))


def build(df):
    t = pd.to_datetime(df["trans_date_trans_time"], format="%Y-%m-%d %H:%M:%S")
    dob = pd.to_datetime(df["dob"], format="%Y-%m-%d")
    out = pd.DataFrame({
        "hour": t.dt.hour.astype("int64"),
        "weekday": t.dt.dayofweek.astype("int64"),
        "age": ((t - dob).dt.days / 365.25).astype("int64"),
        "distance_km": haversine_km(df["lat"], df["long"], df["merch_lat"], df["merch_long"]),
        "amt": df["amt"].astype("float64"),
        "category": df["category"].astype("category"),
        "gender": df["gender"].astype("category"),
        "city_pop": df["city_pop"].astype("int64"),
        LABEL: df[LABEL].astype("int64"),
    })
    return out, t


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", default="data/fraudTrain.csv")
    p.add_argument("--out", default="data")
    p.add_argument("--val-fraction", type=float, default=0.2)
    a = p.parse_args()

    cols = ["trans_date_trans_time", "dob", "lat", "long", "merch_lat", "merch_long",
            "amt", "category", "gender", "city_pop", LABEL]
    raw = pd.read_csv(a.csv, usecols=cols)
    data, t = build(raw)
    data = data.iloc[np.argsort(t.values, kind="stable")].reset_index(drop=True)
    cut = int(len(data) * (1 - a.val_fraction))
    train, val = data.iloc[:cut], data.iloc[cut:]

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    train.to_parquet(out / "train.parquet", index=False)
    val.to_parquet(out / "val.parquet", index=False)
    sorted_t = t.sort_values().reset_index(drop=True)
    for name, d, lo, hi in (("train", train, 0, cut - 1), ("val", val, cut, len(data) - 1)):
        print(f"{name}: {len(d):,} rows, fraud {d[LABEL].mean():.4%}, "
              f"{sorted_t[lo]} .. {sorted_t[hi]}")


if __name__ == "__main__":
    main()
