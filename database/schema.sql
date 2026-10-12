-- ChainCircle off-chain transaction log (SQLite)
--
-- The blockchain is the source of truth for circles, payments and reputation.
-- This table is an index/cache of every transaction sent from the web UI so that
-- history can be queried quickly. Each row starts as 'pending' and is updated by
-- the backend only after it verifies the receipt on Sepolia via JSON-RPC.

CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash       TEXT    NOT NULL UNIQUE,              -- 0x + 64 hex chars, lower-case
    action        TEXT    NOT NULL,                     -- createCircle | joinCircle | leaveCircle | cancelCircle
                                                        -- | contribute | settleRound | withdraw
    from_address  TEXT    NOT NULL,                     -- sender wallet, lower-case
    circle_id     INTEGER,                              -- NULL for withdraw / createCircle
    value_eth     TEXT    NOT NULL DEFAULT '0',         -- ETH sent with the tx (decimal string, no float rounding)
    status        TEXT    NOT NULL DEFAULT 'pending',   -- pending | confirmed | failed
    block_number  INTEGER,                              -- filled after on-chain verification
    gas_used      INTEGER,                              -- filled after on-chain verification
    created_at    INTEGER NOT NULL,                     -- unix seconds
    updated_at    INTEGER NOT NULL                      -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_tx_from   ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_tx_circle ON transactions(circle_id);
