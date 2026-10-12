"""
Export the live transaction log into a local SQLite sample database.

Render's free tier has an ephemeral disk, so this script snapshots the deployed
app's history (via its public REST API) into database/chaincircle_sample.db,
using the same schema as the app (database/schema.sql). A CSV copy is written too.

Usage:
    python scripts/export_db.py                                   # from the Render deployment
    python scripts/export_db.py --url http://127.0.0.1:5000       # from a local server
"""

import argparse
import csv
import json
import sqlite3
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "database" / "schema.sql"
COLUMNS = ["tx_hash", "action", "from_address", "circle_id", "value_eth", "status",
           "block_number", "gas_used", "created_at", "updated_at"]


def http_json(url, method="GET", timeout=90):
    req = urllib.request.Request(url, method=method, headers={"Accept": "application/json", "User-Agent": "ChainCircle-export/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="https://chaincircle.onrender.com", help="base URL of the deployed app")
    parser.add_argument("--out", default=str(ROOT / "database" / "chaincircle_sample.db"), help="output .db path")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    print(f"Fetching transactions from {base} ...")
    txs = http_json(f"{base}/api/transactions?limit=200")["transactions"]

    # Ask the backend to verify anything still pending so the snapshot has final statuses.
    for i, tx in enumerate(txs):
        if tx["status"] == "pending":
            try:
                txs[i] = http_json(f"{base}/api/transactions/{tx['tx_hash']}/verify", method="POST")["transaction"]
            except Exception as exc:  # keep the pending row if verification is unavailable
                print(f"  could not verify {tx['tx_hash']}: {exc}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    with sqlite3.connect(out) as db:
        db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        # Insert oldest first so ids follow chronological order.
        db.executemany(
            f"INSERT INTO transactions ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})",
            [tuple(tx.get(c) for c in COLUMNS) for tx in reversed(txs)],
        )

    csv_path = out.with_suffix(".csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        for tx in reversed(txs):
            writer.writerow([tx.get(c) for c in COLUMNS])

    counts = {}
    for tx in txs:
        counts[tx["status"]] = counts.get(tx["status"], 0) + 1
    print(f"Wrote {len(txs)} transactions -> {out} and {csv_path}")
    print(f"Status breakdown: {counts or 'none'}")


if __name__ == "__main__":
    main()
