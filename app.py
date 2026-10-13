"""
ChainCircle - Flask backend

Responsibilities
  * Serve the web interface (templates/ + static/).
  * Provide the contract address, chain id and ABI to the frontend (/api/config).
  * Keep an off-chain transaction log in SQLite for fast history queries.
  * Independently VERIFY every logged transaction against the Sepolia blockchain
    through JSON-RPC, so the database never trusts the browser's claims.

The blockchain stays the source of truth; SQLite is only an index / cache.
"""

import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from decimal import Decimal, InvalidOperation
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Configuration (override with environment variables on Render)
# ---------------------------------------------------------------------------
CONTRACT_ADDRESS = os.environ.get("CONTRACT_ADDRESS", "0x8Fe1cf2c1927e66D8493Cee995e19Dd10698FB31").strip()
CHAIN_ID = int(os.environ.get("CHAIN_ID", "11155111"))  # Sepolia
CHAIN_NAME = os.environ.get("CHAIN_NAME", "Sepolia")
RPC_URL = os.environ.get("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")
EXPLORER_URL = os.environ.get("EXPLORER_URL", "https://sepolia.etherscan.io")
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", BASE_DIR / "instance" / "chaincircle.db"))
ABI_PATH = BASE_DIR / "abi" / "ChainCircle.json"
SAMPLE_DB_PATH = BASE_DIR / "database" / "chaincircle_sample.db"

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
ALLOWED_ACTIONS = {
    "createCircle",
    "joinCircle",
    "leaveCircle",
    "cancelCircle",
    "contribute",
    "settleRound",
    "withdraw",
}
ALLOWED_STATUSES = {"pending", "confirmed", "failed"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024  # reject oversized request bodies

with open(ABI_PATH, encoding="utf-8") as f:
    CONTRACT_ABI = json.load(f)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
SCHEMA = (BASE_DIR / "database" / "schema.sql").read_text(encoding="utf-8")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATABASE_PATH) as db:
        db.executescript(SCHEMA)
        # Render's free disk is wiped on every deploy/restart: re-seed the verified demo history so it is never empty.
        empty = db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0
        if empty and SAMPLE_DB_PATH.exists() and SAMPLE_DB_PATH.resolve() != DATABASE_PATH.resolve():
            db.execute("ATTACH DATABASE ? AS sample", (str(SAMPLE_DB_PATH),))
            cols = "tx_hash, action, from_address, circle_id, value_eth, status, block_number, gas_used, block_time, created_at, updated_at"
            db.execute(f"INSERT OR IGNORE INTO transactions ({cols}) SELECT {cols} FROM sample.transactions ORDER BY id")
            db.commit()
            db.execute("DETACH DATABASE sample")


init_db()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def error(message, status=400):
    return jsonify({"ok": False, "error": message}), status


def row_to_dict(row):
    d = dict(row)
    d["explorer_url"] = f"{EXPLORER_URL}/tx/{d['tx_hash']}"
    return d


_hits = defaultdict(deque)


def rate_limited(bucket, limit=30, window=60):
    """Very small in-memory rate limiter for write endpoints (per client IP and endpoint)."""
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()
    now = time.time()
    q = _hits[(bucket, ip)]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


def rpc_call(method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    # Explicit User-Agent: public RPCs behind Cloudflare reject Python's default one (error 1010).
    req = urllib.request.Request(
        RPC_URL, data=payload, headers={"Content-Type": "application/json", "User-Agent": "ChainCircle/1.0"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read().decode())
    if "error" in body:
        raise RuntimeError(body["error"].get("message", "RPC error"))
    return body.get("result")


def receipt_is_valid(tx, receipt, claimed_from):
    """
    A transaction counts as confirmed only if it succeeded AND our contract emitted an event in it.

    We deliberately do not require tx.to == CONTRACT_ADDRESS: smart-account wallets (e.g. MetaMask
    accounts upgraded with EIP-7702) route calls through a delegation contract, so `to` is the
    wallet's router while our contract is still the one executing. Every state-changing function
    of ChainCircle emits an event, so "a log from our contract" is the reliable signal.
    """
    if receipt.get("status") != "0x1":
        return False
    contract = CONTRACT_ADDRESS.lower()
    our_logs = [log for log in receipt.get("logs", []) if (log.get("address") or "").lower() == contract]
    if contract and not our_logs:
        return False
    # The claimed wallet must be the sender, or appear as an indexed account in one of our events
    # (covers relayed/sponsored transactions where a relayer pays the gas).
    if (tx.get("from") or "").lower() == claimed_from:
        return True
    padded = "0x" + "0" * 24 + claimed_from[2:]
    return any(padded in [t.lower() for t in log.get("topics", [])[1:]] for log in our_logs)


def validate_transaction_payload(data):
    """Return (clean_dict, None) or (None, error_message)."""
    if not isinstance(data, dict):
        return None, "Request body must be a JSON object."

    tx_hash = str(data.get("tx_hash", "")).strip()
    if not TX_HASH_RE.match(tx_hash):
        return None, "Invalid transaction hash."

    action = str(data.get("action", "")).strip()
    if action not in ALLOWED_ACTIONS:
        return None, f"Unknown action. Allowed: {', '.join(sorted(ALLOWED_ACTIONS))}."

    from_address = str(data.get("from_address", "")).strip()
    if not ADDRESS_RE.match(from_address):
        return None, "Invalid wallet address."

    circle_id = data.get("circle_id")
    if circle_id is not None:
        try:
            circle_id = int(circle_id)
        except (TypeError, ValueError):
            return None, "circle_id must be an integer."
        if circle_id < 0 or circle_id > 10**9:
            return None, "circle_id out of range."

    try:
        value = Decimal(str(data.get("value_eth", "0")))
    except InvalidOperation:
        return None, "value_eth must be a number."
    if value < 0 or value > Decimal("1000000"):
        return None, "value_eth out of range."

    return {
        "tx_hash": tx_hash.lower(),
        "action": action,
        "from_address": from_address.lower(),
        "circle_id": circle_id,
        "value_eth": format(value.normalize(), "f"),
    }, None


# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------
@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return resp


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return jsonify({"ok": True, "contract_configured": bool(ADDRESS_RE.match(CONTRACT_ADDRESS))})


@app.get("/api/config")
def config():
    return jsonify(
        {
            "ok": True,
            "contract_address": CONTRACT_ADDRESS if ADDRESS_RE.match(CONTRACT_ADDRESS) else None,
            "chain_id": CHAIN_ID,
            "chain_id_hex": hex(CHAIN_ID),
            "chain_name": CHAIN_NAME,
            "rpc_url": RPC_URL,
            "explorer_url": EXPLORER_URL,
            "abi": CONTRACT_ABI,
        }
    )


@app.get("/api/transactions")
def list_transactions():
    address = request.args.get("address", "").strip()
    circle_id = request.args.get("circle_id", "").strip()
    try:
        limit = min(max(int(request.args.get("limit", 50)), 1), 200)
    except ValueError:
        return error("limit must be an integer.")

    query = "SELECT * FROM transactions WHERE 1=1"
    params = []
    if address:
        if not ADDRESS_RE.match(address):
            return error("Invalid wallet address.")
        query += " AND from_address = ?"
        params.append(address.lower())
    if circle_id:
        if not circle_id.isdigit():
            return error("circle_id must be an integer.")
        query += " AND circle_id = ?"
        params.append(int(circle_id))
    query += " ORDER BY COALESCE(block_time, created_at) DESC, id DESC LIMIT ?"
    params.append(limit)

    rows = get_db().execute(query, params).fetchall()
    return jsonify({"ok": True, "transactions": [row_to_dict(r) for r in rows]})


@app.post("/api/transactions")
def create_transaction():
    if rate_limited("create"):
        return error("Too many requests, please slow down.", 429)

    clean, err = validate_transaction_payload(request.get_json(silent=True))
    if err:
        return error(err)

    now = int(time.time())
    db = get_db()
    try:
        db.execute(
            """INSERT INTO transactions
               (tx_hash, action, from_address, circle_id, value_eth, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
            (clean["tx_hash"], clean["action"], clean["from_address"], clean["circle_id"],
             clean["value_eth"], now, now),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return error("Transaction already recorded.", 409)

    row = db.execute("SELECT * FROM transactions WHERE tx_hash = ?", (clean["tx_hash"],)).fetchone()
    return jsonify({"ok": True, "transaction": row_to_dict(row)}), 201


@app.post("/api/transactions/<tx_hash>/verify")
def verify_transaction(tx_hash):
    """Ask the blockchain (not the browser) whether the transaction succeeded."""
    if rate_limited("verify", limit=60):
        return error("Too many requests, please slow down.", 429)
    if not TX_HASH_RE.match(tx_hash):
        return error("Invalid transaction hash.")

    db = get_db()
    row = db.execute("SELECT * FROM transactions WHERE tx_hash = ?", (tx_hash.lower(),)).fetchone()
    if row is None:
        return error("Transaction not found.", 404)
    if row["status"] == "confirmed":
        return jsonify({"ok": True, "transaction": row_to_dict(row)})

    try:
        tx = rpc_call("eth_getTransactionByHash", [tx_hash])
        receipt = rpc_call("eth_getTransactionReceipt", [tx_hash])
        block = rpc_call("eth_getBlockByNumber", [receipt["blockNumber"], False]) if receipt else None
    except (urllib.error.URLError, RuntimeError, TimeoutError, json.JSONDecodeError) as exc:
        return error(f"Could not reach the blockchain RPC: {exc}", 502)

    if tx is None and time.time() - row["created_at"] > 30 * 60:
        # Never reached the chain (dropped, replaced or fabricated hash).
        db.execute("UPDATE transactions SET status = 'failed', updated_at = ? WHERE tx_hash = ?",
                   (int(time.time()), tx_hash.lower()))
        db.commit()
        row = db.execute("SELECT * FROM transactions WHERE tx_hash = ?", (tx_hash.lower(),)).fetchone()
        return jsonify({"ok": True, "transaction": row_to_dict(row), "message": "Transaction not found on-chain."})
    if tx is None or receipt is None:
        return jsonify({"ok": True, "transaction": row_to_dict(row), "message": "Still pending."})

    status = "confirmed" if receipt_is_valid(tx, receipt, row["from_address"]) else "failed"
    block_time = int(block["timestamp"], 16) if block else None

    db.execute(
        """UPDATE transactions SET status = ?, block_number = ?, gas_used = ?, block_time = ?, updated_at = ?
           WHERE tx_hash = ?""",
        (status, int(receipt["blockNumber"], 16), int(receipt["gasUsed"], 16), block_time,
         int(time.time()), tx_hash.lower()),
    )
    db.commit()
    row = db.execute("SELECT * FROM transactions WHERE tx_hash = ?", (tx_hash.lower(),)).fetchone()
    return jsonify({"ok": True, "transaction": row_to_dict(row)})


@app.get("/api/stats")
def stats():
    db = get_db()
    total = db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    by_status = {s: 0 for s in ALLOWED_STATUSES}
    for r in db.execute("SELECT status, COUNT(*) AS n FROM transactions GROUP BY status"):
        by_status[r["status"]] = r["n"]
    by_action = {r["action"]: r["n"] for r in db.execute(
        "SELECT action, COUNT(*) AS n FROM transactions GROUP BY action")}
    wallets = db.execute("SELECT COUNT(DISTINCT from_address) FROM transactions").fetchone()[0]
    return jsonify({"ok": True, "total": total, "by_status": by_status, "by_action": by_action, "wallets": wallets})


@app.errorhandler(404)
def not_found(_e):
    if request.path.startswith("/api/"):
        return error("Not found.", 404)
    return render_template("index.html"), 404


@app.errorhandler(413)
def too_large(_e):
    return error("Request body too large.", 413)


@app.errorhandler(500)
def server_error(_e):
    return error("Internal server error.", 500)


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", port=int(os.environ.get("PORT", 5000)))
