# ChainCircle — On-chain Rotating Savings Circles (ROSCA DApp)

> SC6113 Individual Assignment · Financial Decentralized Application
> Solidity · Ethereum Sepolia · MetaMask · Flask · SQLite · HTML/CSS/JS · Render

**Live demo:** `https://<your-service>.onrender.com` ← replace after deploying
**Smart contract (Sepolia):** [`0x8Fe1cf2c1927e66D8493Cee995e19Dd10698FB31`](https://sepolia.etherscan.io/address/0x8Fe1cf2c1927e66D8493Cee995e19Dd10698FB31)

---

## 1. Problem

A **Rotating Savings and Credit Association (ROSCA)**, also known as 标会 / 合会 (China), tontine (West Africa),
susu (Ghana), chit fund (India) or tanda (Mexico), is one of the most widely used informal financial tools in
the world, especially for people without access to banks. A group of members contributes a fixed amount every
round, and each round one member receives the entire pot until everyone has received it once.

ROSCAs suffer from a serious **trust problem**:

* A member who has already received the pot may **stop paying** (default risk).
* The organiser holds everybody's cash and may **run away with it**.
* Records are kept on paper or chat groups, so they are **opaque and easy to dispute**.
* A reliable payer has **no portable credit history**.

## 2. Solution

ChainCircle moves the whole ROSCA lifecycle into a Solidity smart contract:

| Problem | ChainCircle mechanism |
|---|---|
| Organiser holds the money | Funds are held by the contract and only released by its rules |
| Members default after receiving the pot | Every member locks **collateral**; a missed payment is automatically covered from the defaulter's collateral |
| Nobody settles the round | **Anyone** can call `settleRound()` after the deadline (permissionless keeper) |
| Disputes about who paid | Every payment is an on-chain event, visible on Etherscan |
| No credit history | On-chain **reputation**: on-time payments, defaults, completed circles |

## 3. Features

* Connect a MetaMask wallet, with automatic detection of and switching to the Sepolia network
* Create a circle by choosing contribution, members (2–12), round duration and collateral, with a live
  "collateral coverage" risk indicator
* Browse and filter circles (Open / Active / Completed), join by locking collateral, or leave before the circle starts
* Pay each round's contribution; the last payment automatically pays the pot to that round's recipient
* Settle an expired round, with defaults covered from collateral
* Withdraw payouts and refunded collateral (pull-payment pattern)
* View a reputation score and personal statistics
* See transaction history stored by Flask/SQLite **and independently verified on-chain** by the backend
* Live countdowns, toast notifications for each transaction stage, and links to Etherscan
* Friendly error messages decoded from Solidity custom errors
* Responsive layout that works on mobile and desktop

## 4. Architecture

```
┌───────────────────────────┐        ┌──────────────────────────────┐
│  Browser (HTML/CSS/JS)    │  REST  │  Flask backend (app.py)      │
│  ethers.js v6             │◄──────►│  /api/config  (ABI, address) │
│                           │        │  /api/transactions (SQLite)  │
│  ┌─────────────────────┐  │        │  /api/transactions/<h>/verify│──┐
│  │ MetaMask (signer)   │  │        └──────────────────────────────┘  │ JSON-RPC
│  └─────────┬───────────┘  │                                          │ (receipt
└────────────┼──────────────┘                                          │  check)
             │ signed tx / reads                                       ▼
             ▼                                              ┌────────────────────┐
     ┌────────────────────────────────────────────────────► │ Ethereum Sepolia   │
     │                                                      │ ChainCircle.sol    │
     └──────────────────────────────────────────────────────└────────────────────┘
```

* **Blockchain = source of truth** (funds, membership, payments, reputation).
* **Flask + SQLite = index/cache** of transactions for fast history queries. The backend never trusts the
  browser: it re-checks every transaction's receipt, sender and target contract through JSON-RPC.
* Private keys **never leave MetaMask**. The server holds no keys.

## 5. Project structure

```
├── contracts/ChainCircle.sol     # Solidity smart contract
├── abi/ChainCircle.json          # Contract ABI (used by Flask + frontend)
├── test/ChainCircle.t.sol        # 26 Foundry unit tests
├── app.py                        # Flask backend (API + SQLite + on-chain verification)
├── templates/index.html          # Web UI
├── static/css/style.css          # Styles
├── static/js/app.js              # MetaMask / ethers.js / API logic
├── requirements.txt              # Python dependencies
├── render.yaml                   # Render deployment blueprint
└── foundry.toml                  # Foundry config (tests)
```

## 6. Smart contract design

**State machine:** `Open → Active → Completed`, or `Open → Cancelled`

| Function | Who | What |
|---|---|---|
| `createCircle(name, contribution, maxMembers, roundDuration)` payable | anyone | Creates a circle; `msg.value` = collateral; creator becomes member #1 |
| `joinCircle(id)` payable | non-member | Locks exactly the collateral; the circle starts automatically when full |
| `leaveCircle(id)` | member (not creator) | Leaves before the start; collateral becomes withdrawable |
| `cancelCircle(id)` | creator | Cancels before the start; all collateral is refunded |
| `contribute(id)` payable | member | Pays exactly `contribution` before the deadline; the last payment settles the round |
| `settleRound(id)` | anyone | After the deadline, covers defaults from collateral and pays the recipient |
| `withdraw()` | anyone | Pulls credited ETH (pots + collateral refunds) |

Views: `getCircle`, `getMembers`, `getMember`, `getRoundStatus`, `hasPaid`, `roundDeadline`,
`getUserCircles`, `getReputation`, `pendingWithdrawals`.

Events: `CircleCreated`, `MemberJoined`, `MemberLeft`, `CircleStarted`, `ContributionMade`,
`DefaultCovered`, `RoundSettled`, `CircleCompleted`, `CircleCancelled`, `Withdrawal`.

### Security considerations

| Risk | Mitigation |
|---|---|
| Re-entrancy | Only `withdraw()` sends ETH; it uses Checks-Effects-Interactions **and** a `nonReentrant` guard |
| Denial of service by a malicious receiver | **Pull-payment** pattern: rounds never push ETH, so a contract that reverts on receive cannot block a circle |
| Unauthorized actions | Role checks (creator / member / anyone) and status checks on every function |
| Invalid input | Name length, member count, duration range, minimum amounts, and **exact** ETH amounts enforced on-chain (plus client and server validation) |
| Accidental ETH transfers | No `receive()` / `fallback()`; plain transfers are rejected |
| Unbounded gas | Members capped at 12, so every loop is bounded |
| Integer overflow | Solidity ≥0.8 checked arithmetic; `unchecked` used only where overflow is impossible |
| XSS from on-chain strings | All user-controlled text is HTML-escaped before rendering |
| Forged history entries | The backend verifies receipt status, `from` and `to` via RPC before marking a transaction confirmed |
| Private-key exposure | Keys stay in MetaMask; the server stores no secrets |
| Backend abuse | Request-size limit, rate limiting on write endpoints, strict regex validation, parameterised SQL |

### Gas optimisation

* Custom errors instead of revert strings
* Packed structs (`uint40` timestamps, `uint8` counters, `uint128` amounts share storage slots)
* `calldata` for string input, `unchecked` increments, cached storage reads in loops
* Round settles automatically on the last payment (no extra transaction in the happy path)

Gas report (Foundry, optimizer 200 runs):

| Function | Avg gas |
|---|---|
| Deployment | ~2.12M |
| `createCircle` | ~251k |
| `joinCircle` | ~127k (≈206k when it starts the circle) |
| `contribute` | ~67k (≈141k when it settles the round) |
| `settleRound` | ~97k |
| `withdraw` | ~32k |

## 7. Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py   # uses the deployed Sepolia contract by default; override with CONTRACT_ADDRESS            # http://127.0.0.1:5000
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CONTRACT_ADDRESS` | `0x8Fe1…FB31` | Deployed ChainCircle address |
| `CHAIN_ID` | `11155111` | Sepolia |
| `CHAIN_NAME` | `Sepolia` | Label shown in the UI |
| `RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | Read-only RPC for frontend reads and backend verification |
| `EXPLORER_URL` | `https://sepolia.etherscan.io` | Block explorer |
| `DATABASE_PATH` | `instance/chaincircle.db` | SQLite file |

## 8. Deploying the smart contract (Remix + MetaMask)

1. Get Sepolia test ETH from a faucet (e.g. Google Cloud Web3 faucet or the Alchemy Sepolia faucet).
2. Open <https://remix.ethereum.org>, create `ChainCircle.sol`, and paste `contracts/ChainCircle.sol` into it.
3. **Solidity Compiler** tab: compiler `0.8.24`, enable optimization (200), then click *Compile*.
4. **Deploy & Run** tab: Environment = *Injected Provider – MetaMask*, with MetaMask on **Sepolia** → *Deploy* → confirm.
5. Copy the deployed address and set it as `CONTRACT_ADDRESS`.
6. (Optional) Verify the source on Sepolia Etherscan.

## 9. Deploying the web app to Render

1. Push this folder to a GitHub repository.
2. On <https://render.com>: **New → Blueprint** → select the repo (uses `render.yaml`).
   *Or* **New → Web Service**: build `pip install -r requirements.txt`, start `gunicorn app:app`.
3. `CONTRACT_ADDRESS` is preset in `render.yaml`; change it only if you redeploy the contract.
4. Deploy and open `https://<service>.onrender.com`.

> Render's free tier has an ephemeral disk, so the SQLite history may reset when the service restarts.
> On-chain data (circles, payments, reputation) is never lost.

## 10. Testing

### Smart contract unit tests (Foundry)

```bash
forge test -vv
forge test --gas-report
```

The 26 tests cover input validation, joining and auto-start, leave and cancel refunds, wrong amounts,
double payments, late payments, non-member access, the full 3-round happy path with exact balance
accounting, default coverage from collateral, reputation updates, withdrawals, and rejection of plain ETH transfers.

### Manual test plan (Sepolia)

Use 2–3 MetaMask accounts (Account 1 = creator, Account 2/3 = members):

1. Connect MetaMask; on the wrong network, the app prompts you to switch to Sepolia.
2. Account 1 creates a circle (3 members, 5-minute rounds); the form rejects invalid input.
3. Accounts 2 and 3 join; the circle becomes **Active**.
4. All three pay; the round settles automatically and Account 1's balance increases. Withdraw.
5. In the next round, only two members pay. After the deadline, click **Settle round**: the
   `DefaultCovered` event fires, the defaulter's collateral drops, and their reputation shows a default.
6. Finish the circle; collateral is returned and completion reputation is updated.
7. Check the **History** tab: each transaction shows as *confirmed*, with an Etherscan link.

## 11. Limitations & future work

* Payout order = join order. Fair random ordering could use **Chainlink VRF**, or an auction/bidding
  ROSCA could let members bid for earlier payouts.
* Collateral below `contribution × (members − 1)` cannot fully cover a worst-case default; the UI shows the
  coverage ratio for this reason.
* Stablecoin (ERC-20/USDC) support to avoid ETH price volatility.
* Automated settlement with Chainlink Automation instead of manual `settleRound()`.
* Reputation as a soulbound token (SBT) usable by other DeFi protocols.
* Persistent PostgreSQL instead of SQLite on Render, and event indexing with The Graph.
