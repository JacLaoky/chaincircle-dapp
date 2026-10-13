/* ChainCircle frontend: MetaMask + ethers v6 + Flask API */
(() => {
  "use strict";

  const STATUS = ["Open", "Active", "Completed", "Cancelled"];
  const STATUS_CLASS = ["open", "active", "completed", "cancelled"];
  const MAX_CIRCLES_LOADED = 60;

  const ERROR_MESSAGES = {
    InvalidName: "Circle name must be 1–40 characters.",
    InvalidMemberCount: "A circle needs between 2 and 12 members.",
    InvalidRoundDuration: "Round duration must be between 2 minutes and 30 days.",
    ContributionTooSmall: "Contribution must be at least 0.0001 ETH.",
    CollateralTooSmall: "Collateral must be at least the contribution amount.",
    AmountTooLarge: "Amount is too large.",
    CircleNotFound: "This circle does not exist.",
    WrongStatus: "This action is not allowed in the circle's current status.",
    AlreadyMember: "You are already a member of this circle.",
    NotMember: "Only members of this circle can do this.",
    NotCreator: "Only the creator can cancel this circle.",
    CreatorCannotLeave: "The creator cannot leave — cancel the circle instead.",
    WrongAmount: "Incorrect ETH amount sent.",
    AlreadyPaid: "You have already paid for this round.",
    RoundExpired: "The payment deadline for this round has passed.",
    RoundNotExpired: "The round deadline has not passed yet.",
    NothingToWithdraw: "You have nothing to withdraw.",
    TransferFailed: "ETH transfer failed.",
    Reentrancy: "Reentrant call blocked.",
  };

  const state = {
    config: null,
    readProvider: null,
    readContract: null,
    browserProvider: null,
    signer: null,
    writeContract: null,
    account: null,
    chainOk: false,
    circles: [],
    filter: "all",
    historyScope: "mine",
    busy: new Set(),
    clockOffset: 0,
    expiredSeen: new Set(), // "circleId:deadline" keys whose expiry already re-rendered the UI
  };

  // ------------------------------------------------------------------ utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");
  const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  const fmtEth = (wei, digits = 4) => {
    const n = Number(ethers.formatEther(wei));
    if (n === 0) return "0";
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  };

  const fmtDuration = (sec) => {
    sec = Number(sec);
    if (sec <= 0) return "0s";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
      m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  };

  // Fixed English locale so dates look the same for every viewer (e.g. "13 Oct 2026, 16:23:24").
  const fmtTime = (unix) =>
    new Date(unix * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // Seconds, aligned to chain time if the local clock is noticeably off (see loadCircles).
  const now = () => Math.floor(Date.now() / 1000) + state.clockOffset;

  function toast(title, body = "", type = "info", ms = 6000) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<b>${escapeHtml(title)}</b>${body}`;
    $("#toasts").appendChild(el);
    if (ms) setTimeout(() => el.remove(), ms);
    return el;
  }

  function banner(html, isError = false) {
    const b = $("#banner");
    if (!html) return b.classList.add("hidden");
    b.innerHTML = html;
    b.classList.toggle("error", isError);
    b.classList.remove("hidden");
  }

  function txLink(hash) {
    return `<a href="${state.config.explorer_url}/tx/${hash}" target="_blank" rel="noopener">View on Etherscan ↗</a>`;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /** Turn any ethers / MetaMask error into a human-readable message. */
  function parseError(err) {
    if (!err) return "Unknown error.";
    if (err.code === "ACTION_REJECTED" || err.code === 4001 || err.info?.error?.code === 4001) {
      return "You rejected the request in MetaMask.";
    }
    if (err.code === "INSUFFICIENT_FUNDS") return "Insufficient Sepolia ETH to pay for this transaction and gas.";

    // Decode the Solidity custom error (ethers fills err.revert for some calls, raw data for others).
    let decoded = err.revert;
    if (!decoded) {
      const data = err.data || err.info?.error?.data?.data || err.info?.error?.data || err.error?.data;
      if (typeof data === "string" && data.startsWith("0x") && state.readContract) {
        try { decoded = state.readContract.interface.parseError(data); } catch (_) { /* ignore */ }
      }
    }
    const name = decoded?.name;
    const arg0 = decoded?.args?.[0];
    if (name && ERROR_MESSAGES[name]) {
      if (name === "WrongAmount" && arg0 != null) return `${ERROR_MESSAGES[name]} Expected ${ethers.formatEther(arg0)} ETH.`;
      if (name === "WrongStatus" && arg0 != null) return `${ERROR_MESSAGES[name]} (status: ${STATUS[Number(arg0)]})`;
      return ERROR_MESSAGES[name];
    }
    return err.shortMessage || err.reason || err.message || "Transaction failed.";
  }

  // ------------------------------------------------------------------ init
  async function init() {
    bindUI();
    updateCreateSummary();

    try {
      const cfg = await api("/api/config");
      state.config = cfg;
    } catch (e) {
      banner(`Cannot reach the backend: ${escapeHtml(e.message)}`, true);
      return;
    }

    const cfg = state.config;
    if (!cfg.contract_address) {
      banner("Smart contract address is not configured. Set the <code>CONTRACT_ADDRESS</code> environment variable on the server.", true);
      renderEmptyGrids("Contract not configured");
      loadHistory();
      return;
    }

    const link = $("#contractLink");
    link.textContent = cfg.contract_address;
    link.href = `${cfg.explorer_url}/address/${cfg.contract_address}`;

    state.readProvider = new ethers.JsonRpcProvider(cfg.rpc_url, cfg.chain_id, { staticNetwork: true });
    state.readContract = new ethers.Contract(cfg.contract_address, cfg.abi, state.readProvider);

    if (!window.ethereum) {
      banner('MetaMask not detected. <a href="https://metamask.io/download/" target="_blank" rel="noopener">Install MetaMask</a> to create or join circles. You can still browse.');
      $("#connectBtn").textContent = "Install MetaMask";
    } else {
      window.ethereum.on("accountsChanged", handleAccountsChanged);
      window.ethereum.on("chainChanged", () => window.location.reload());
      // Silent reconnect if the site was already authorised.
      const accounts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
      if (accounts.length) await handleAccountsChanged(accounts);
    }

    await refreshAll();
    setInterval(tickCountdowns, 1000);
    setInterval(() => refreshAll(true), 30000);
  }

  // ------------------------------------------------------------------ wallet
  async function connectWallet() {
    if (!window.ethereum) {
      window.open("https://metamask.io/download/", "_blank", "noopener");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      await handleAccountsChanged(accounts);
      await refreshAll();
    } catch (e) {
      toast("Connection failed", `<div>${escapeHtml(parseError(e))}</div>`, "error");
    }
  }

  async function handleAccountsChanged(accounts) {
    if (!accounts || !accounts.length) {
      state.account = null;
      state.signer = null;
      state.writeContract = null;
      updateWalletUI();
      renderAll();
      return;
    }
    state.account = ethers.getAddress(accounts[0]);
    state.browserProvider = new ethers.BrowserProvider(window.ethereum);
    await checkNetwork();
    if (state.config?.contract_address) {
      state.signer = await state.browserProvider.getSigner();
      state.writeContract = new ethers.Contract(state.config.contract_address, state.config.abi, state.signer);
    }
    updateWalletUI();
    if (state.readContract) refreshAll(true);
  }

  async function checkNetwork() {
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    state.chainOk = parseInt(chainId, 16) === state.config.chain_id;
    if (!state.chainOk) {
      banner(`Wrong network. Please switch MetaMask to <b>Sepolia</b>. <button class="btn btn-warning btn-sm" id="switchBtn">Switch network</button>`);
      $("#switchBtn")?.addEventListener("click", switchNetwork);
    } else {
      banner(null);
    }
  }

  async function switchNetwork() {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: state.config.chain_id_hex }] });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: state.config.chain_id_hex,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [state.config.rpc_url],
            blockExplorerUrls: [state.config.explorer_url],
          }],
        });
      } else {
        toast("Network switch failed", `<div>${escapeHtml(parseError(e))}</div>`, "error");
      }
    }
  }

  function updateWalletUI() {
    const btn = $("#connectBtn");
    const pill = $("#networkPill");
    if (state.account) {
      btn.textContent = short(state.account);
      btn.classList.replace("btn-primary", "btn-ghost");
      btn.title = state.account;
      pill.textContent = state.chainOk ? state.config.chain_name : "Wrong network";
      pill.className = `pill ${state.chainOk ? "pill-ok" : "pill-bad"}`;
    } else {
      btn.textContent = window.ethereum ? "Connect MetaMask" : "Install MetaMask";
      btn.classList.replace("btn-ghost", "btn-primary");
      pill.textContent = "Not connected";
      pill.className = "pill pill-muted";
    }
  }

  // ------------------------------------------------------------------ data loading
  async function loadCircles() {
    const c = state.readContract;
    const [countRaw, block] = await Promise.all([c.circleCount(), state.readProvider.getBlock("latest")]);
    const count = Number(countRaw);
    const skew = block.timestamp - Math.floor(Date.now() / 1000);
    state.clockOffset = Math.abs(skew) > 60 ? skew : 0;
    const ids = [];
    for (let id = count; id >= 1 && ids.length < MAX_CIRCLES_LOADED; id--) ids.push(id);

    state.circles = await Promise.all(ids.map(async (id) => {
      const [raw, round] = await Promise.all([c.getCircle(id), c.getRoundStatus(id)]);
      const status = Number(raw.status);
      const roundDuration = Number(raw.roundDuration);
      const roundStart = Number(raw.roundStart);
      return {
        id,
        name: raw.name,
        creator: raw.creator,
        contribution: raw.contribution,
        collateral: raw.collateral,
        maxMembers: Number(raw.maxMembers),
        currentRound: Number(raw.currentRound),
        roundDuration,
        roundStart,
        deadline: status === 1 ? roundStart + roundDuration : 0,
        status,
        paidCount: Number(raw.paidCount),
        pot: raw.pot,
        createdAt: Number(raw.createdAt),
        members: Array.from(round[0]),
        paid: Array.from(round[1]),
      };
    }));
    $("#statTotal").textContent = count;
    const locked = state.circles
      .filter((x) => x.status <= 1)
      .reduce((sum, x) => sum + x.collateral * BigInt(x.members.length) + x.pot, 0n);
    $("#statTvl").textContent = `${fmtEth(locked)} ETH locked in active circles`;
  }

  async function loadAccountStats() {
    if (!state.account || !state.readContract) {
      $("#statBalance").textContent = "—";
      $("#statScore").textContent = "—";
      $("#statRep").textContent = "Connect wallet to view";
      $("#statMine").textContent = "—";
      $("#statMineSub").innerHTML = "&nbsp;";
      $("#withdrawBtn").disabled = true;
      return;
    }
    const [bal, rep] = await Promise.all([
      state.readContract.pendingWithdrawals(state.account),
      state.readContract.getReputation(state.account),
    ]);
    $("#statBalance").textContent = `${fmtEth(bal, 6)} ETH`;
    $("#withdrawBtn").disabled = bal === 0n || state.busy.has("withdraw");

    const onTime = Number(rep.onTimePayments), defaults = Number(rep.defaults),
      completed = Number(rep.circlesCompleted), joined = Number(rep.circlesJoined);
    const total = onTime + defaults;
    const score = total === 0 ? "New" : `${Math.round((onTime / total) * 100)}%`;
    $("#statScore").textContent = score;
    $("#statRep").textContent = `${onTime} on-time · ${defaults} default${defaults === 1 ? "" : "s"} · ${completed}/${joined} completed`;

    const mine = state.circles.filter((c) => c.members.some((m) => sameAddr(m, state.account)));
    $("#statMine").textContent = mine.length;
    const due = mine.filter((c) => needsPayment(c)).length;
    $("#statMineSub").textContent = due ? `${due} payment${due > 1 ? "s" : ""} due now` : "No payments due";
  }

  async function refreshAll(silent = false) {
    if (!state.readContract) return;
    if (!silent) renderSkeletons();
    try {
      await loadCircles();
      await loadAccountStats();
      renderAll();
    } catch (e) {
      console.error(e);
      if (!silent) toast("Could not load data from the blockchain", `<div>${escapeHtml(parseError(e))}</div>`, "error");
    }
    loadHistory();
  }

  // ------------------------------------------------------------------ rendering
  function renderSkeletons() {
    $("#exploreGrid").innerHTML = '<div class="skeleton"></div>'.repeat(3);
  }

  function renderEmptyGrids(msg) {
    const html = `<div class="empty-state"><h3>${escapeHtml(msg)}</h3></div>`;
    $("#exploreGrid").innerHTML = html;
    $("#mineGrid").innerHTML = html;
  }

  function renderAll() {
    const list = state.filter === "all" ? state.circles : state.circles.filter((c) => c.status === Number(state.filter));
    $("#exploreGrid").innerHTML = list.length
      ? list.map(circleCard).join("")
      : `<div class="empty-state"><h3>No circles here yet</h3><p>Be the first — create a circle in the <b>Create Circle</b> tab.</p></div>`;

    if (!state.account) {
      $("#mineGrid").innerHTML = `<div class="empty-state"><h3>Connect your wallet</h3><p>Your circles will appear here.</p></div>`;
    } else {
      const mine = state.circles.filter((c) => c.members.some((m) => sameAddr(m, state.account)));
      $("#mineGrid").innerHTML = mine.length
        ? mine.map(circleCard).join("")
        : `<div class="empty-state"><h3>You haven't joined any circle</h3><p>Browse open circles in <b>Explore</b> or create your own.</p></div>`;
    }
    tickCountdowns();
  }

  function myRole(c) {
    if (!state.account) return null;
    if (sameAddr(c.creator, state.account)) return "Creator";
    if (c.members.some((m) => sameAddr(m, state.account))) return "Member";
    return null;
  }

  function needsPayment(c) {
    if (!state.account || c.status !== 1 || now() > c.deadline) return false;
    const idx = c.members.findIndex((m) => sameAddr(m, state.account));
    return idx >= 0 && !c.paid[idx];
  }

  function actionButtons(c, compact = true) {
    const btns = [];
    const isMember = c.members.some((m) => sameAddr(m, state.account));
    const isCreator = sameAddr(c.creator, state.account);
    const busy = (k) => (state.busy.has(`${k}-${c.id}`) ? "disabled" : "");

    if (c.status === 0) {
      if (!isMember) btns.push(`<button class="btn btn-primary btn-sm" data-act="join" data-id="${c.id}" ${busy("join")}>Join · lock ${fmtEth(c.collateral)} ETH</button>`);
      else if (isCreator) btns.push(`<button class="btn btn-danger btn-sm" data-act="cancel" data-id="${c.id}" ${busy("cancel")}>Cancel circle</button>`);
      else btns.push(`<button class="btn btn-danger btn-sm" data-act="leave" data-id="${c.id}" ${busy("leave")}>Leave</button>`);
    } else if (c.status === 1) {
      if (now() > c.deadline) {
        btns.push(`<button class="btn btn-warning btn-sm" data-act="settle" data-id="${c.id}" ${busy("settle")}>Settle round ${c.currentRound}</button>`);
      } else if (needsPayment(c)) {
        btns.push(`<button class="btn btn-success btn-sm" data-act="contribute" data-id="${c.id}" ${busy("contribute")}>Pay ${fmtEth(c.contribution)} ETH</button>`);
      } else if (isMember) {
        btns.push(`<span class="paid-yes">✓ Paid this round</span>`);
      }
    }
    if (compact) btns.push(`<button class="btn btn-ghost btn-sm" data-act="details" data-id="${c.id}">Details</button>`);
    return btns.join("");
  }

  function circleCard(c) {
    const role = myRole(c);
    const joined = c.members.length;
    let progressPct, progressLabel, info;

    if (c.status === 0) {
      progressPct = (joined / c.maxMembers) * 100;
      progressLabel = `${joined}/${c.maxMembers} members joined`;
      info = `<span>Waiting for ${c.maxMembers - joined} more</span><span>Round: ${fmtDuration(c.roundDuration)}</span>`;
    } else if (c.status === 1) {
      progressPct = ((c.currentRound - 1) / c.maxMembers) * 100;
      progressLabel = `Round ${c.currentRound} of ${c.maxMembers} · ${c.paidCount}/${joined} paid`;
      info = `<span>Recipient: <b>${short(c.members[c.currentRound - 1])}</b></span>
              <span>⏱ <span class="countdown" data-deadline="${c.deadline}"></span></span>`;
    } else if (c.status === 2) {
      progressPct = 100;
      progressLabel = `Completed · ${c.maxMembers} rounds`;
      info = `<span>All members received the pot</span>`;
    } else {
      progressPct = 0;
      progressLabel = "Cancelled before start";
      info = `<span>Collateral refunded</span>`;
    }

    return `
      <article class="card circle-card">
        <div class="cc-head">
          <div>
            <div class="cc-id">#${c.id} · by ${short(c.creator)}</div>
            <h3 class="cc-title">${escapeHtml(c.name)}</h3>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${role ? `<span class="badge badge-role">${role}</span>` : ""}
            <span class="badge badge-${STATUS_CLASS[c.status]}">${STATUS[c.status]}</span>
          </div>
        </div>
        <div class="cc-metrics">
          <div class="metric"><span>Per round</span><b>${fmtEth(c.contribution)} Ξ</b></div>
          <div class="metric"><span>Pot</span><b>${fmtEth(c.contribution * BigInt(c.maxMembers))} Ξ</b></div>
          <div class="metric"><span>Collateral</span><b>${fmtEth(c.collateral)} Ξ</b></div>
        </div>
        <div>
          <div class="cc-info" style="margin-bottom:6px"><span>${progressLabel}</span></div>
          <div class="progress"><div style="width:${progressPct}%"></div></div>
        </div>
        <div class="cc-info">${info}</div>
        <div class="cc-actions">${actionButtons(c)}</div>
      </article>`;
  }

  function openDetails(id) {
    const c = state.circles.find((x) => x.id === id);
    if (!c) return;
    const rows = c.members.map((m, i) => {
      const pos = i + 1;
      const isCurrent = c.status === 1 && pos === c.currentRound;
      const received = c.status === 2 || (c.status === 1 && pos < c.currentRound);
      let payTag = "";
      if (c.status === 1) payTag = c.paid[i] ? `<span class="paid-yes">✓ paid</span>` : `<span class="paid-no">not paid</span>`;
      return `
        <li class="${isCurrent ? "current" : ""}">
          <span class="member-pos">${pos}</span>
          <span class="mono" title="${m}">${short(m)}</span>
          ${sameAddr(m, state.account) ? '<span class="badge badge-role">You</span>' : ""}
          ${sameAddr(m, c.creator) ? '<span class="badge badge-open">Creator</span>' : ""}
          <span class="member-meta">
            ${isCurrent ? '<span class="badge badge-active">Receives this round</span>' : ""}
            ${received ? '<span class="badge badge-completed">Received pot</span>' : ""}
            ${payTag}
          </span>
        </li>`;
    }).join("");
    const empty = Array.from({ length: c.maxMembers - c.members.length }, (_, k) =>
      `<li><span class="member-pos">${c.members.length + k + 1}</span><span class="muted">Open seat</span></li>`).join("");

    $("#modalContent").dataset.id = c.id;
    $("#modalContent").innerHTML = `
      <div class="cc-id">Circle #${c.id} · created ${fmtTime(c.createdAt)}</div>
      <h2>${escapeHtml(c.name)}</h2>
      <span class="badge badge-${STATUS_CLASS[c.status]}">${STATUS[c.status]}</span>
      <div class="detail-grid">
        <div class="metric"><span>Contribution</span><b>${fmtEth(c.contribution, 6)} ETH</b></div>
        <div class="metric"><span>Pot per round</span><b>${fmtEth(c.contribution * BigInt(c.maxMembers), 6)} ETH</b></div>
        <div class="metric"><span>Collateral</span><b>${fmtEth(c.collateral, 6)} ETH</b></div>
        <div class="metric"><span>Round length</span><b>${fmtDuration(c.roundDuration)}</b></div>
        <div class="metric"><span>Round</span><b>${c.status === 1 ? `${c.currentRound} / ${c.maxMembers}` : c.status === 2 ? "Done" : "—"}</b></div>
        <div class="metric"><span>Deadline</span><b>${c.status === 1 ? `<span class="countdown" data-deadline="${c.deadline}"></span>` : "—"}</b></div>
      </div>
      <h3 style="margin:0 0 10px">Members &amp; payout order</h3>
      <ul class="member-list">${rows}${c.status === 0 ? empty : ""}</ul>
      <div class="cc-actions">${actionButtons(c, false)}</div>`;
    $("#modal").classList.remove("hidden");
    tickCountdowns();
  }

  function closeModal() { $("#modal").classList.add("hidden"); }

  function tickCountdowns() {
    const t = now();
    $$(".countdown").forEach((el) => {
      const left = Number(el.dataset.deadline) - t;
      el.textContent = left > 0 ? `${fmtDuration(left)} left` : "Deadline passed";
      el.classList.toggle("expired", left <= 0);
    });

    // When a round deadline passes, re-render so "Pay" turns into "Settle round" without a manual refresh.
    let changed = false;
    for (const c of state.circles) {
      const key = `${c.id}:${c.deadline}`;
      if (c.status === 1 && c.deadline && t > c.deadline && !state.expiredSeen.has(key)) {
        state.expiredSeen.add(key);
        changed = true;
      }
    }
    if (changed) {
      renderAll();
      const openId = Number($("#modalContent").dataset.id);
      if (openId && !$("#modal").classList.contains("hidden")) openDetails(openId);
    }
  }

  // ------------------------------------------------------------------ history
  async function loadHistory() {
    const body = $("#historyBody");
    let url = "/api/transactions?limit=50";
    if (state.historyScope === "mine") {
      if (!state.account) {
        body.innerHTML = `<tr><td colspan="7" class="empty">Connect your wallet to see your transactions, or switch to “All transactions”.</td></tr>`;
        return;
      }
      url += `&address=${state.account}`;
    }
    try {
      const { transactions } = await api(url);
      if (!transactions.length) {
        body.innerHTML = `<tr><td colspan="7" class="empty">No transactions yet.</td></tr>`;
        return;
      }
      body.innerHTML = transactions.map((t) => `
        <tr>
          <td>${fmtTime(t.block_time || t.created_at)}</td>
          <td><b>${escapeHtml(t.action)}</b></td>
          <td>${t.circle_id ? `#${t.circle_id}` : "—"}</td>
          <td>${escapeHtml(t.value_eth)}</td>
          <td class="mono">${short(t.from_address)}</td>
          <td><span class="badge badge-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
          <td><a href="${escapeHtml(t.explorer_url)}" target="_blank" rel="noopener" class="mono">${short(t.tx_hash)}</a></td>
        </tr>`).join("");
      // Ask the backend to verify any transaction still pending.
      transactions.filter((t) => t.status === "pending")
        .forEach((t) => api(`/api/transactions/${t.tx_hash}/verify`, { method: "POST" }).catch(() => {}));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="7" class="empty">Could not load history: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  // ------------------------------------------------------------------ transactions
  /**
   * Generic transaction runner:
   *  1. wallet + network checks
   *  2. gas estimation (surfaces contract revert reasons BEFORE MetaMask opens)
   *  3. send -> record in backend -> wait for confirmation -> backend verification
   */
  async function runTx({ key, label, method, args = [], value = 0n, circleId = null, action }) {
    if (!state.account) { await connectWallet(); if (!state.account) return false; }
    if (!state.chainOk) { await switchNetwork(); return false; }
    if (!state.writeContract) { toast("Contract not configured", "", "error"); return false; }
    if (state.busy.has(key)) return false;

    state.busy.add(key);
    renderAll();
    let pendingToast;
    try {
      const overrides = value > 0n ? { value } : {};
      await state.writeContract[method].estimateGas(...args, overrides);

      pendingToast = toast(`${label}: confirm in MetaMask…`, "", "pending", 0);
      const tx = await state.writeContract[method](...args, overrides);
      pendingToast.innerHTML = `<b>${escapeHtml(label)}: pending…</b>${txLink(tx.hash)}`;

      api("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          tx_hash: tx.hash,
          action,
          from_address: state.account,
          circle_id: circleId,
          value_eth: ethers.formatEther(value),
        }),
      }).catch((e) => console.warn("Backend log failed:", e.message));

      const receipt = await tx.wait();
      pendingToast.remove();
      if (receipt.status !== 1) throw new Error("Transaction reverted on-chain.");
      toast(`${label} confirmed ✓`, `<div class="small">Block ${receipt.blockNumber}</div>${txLink(tx.hash)}`, "success", 10000);

      await api(`/api/transactions/${tx.hash}/verify`, { method: "POST" }).catch(() => {});
      return receipt;
    } catch (e) {
      pendingToast?.remove();
      console.error(e);
      toast(`${label} failed`, `<div>${escapeHtml(parseError(e))}</div>`, "error", 9000);
      return false;
    } finally {
      state.busy.delete(key);
      await refreshAll(true);
      if (!$("#modal").classList.contains("hidden")) {
        const id = Number($("#modalContent").dataset.id);
        if (id) openDetails(id);
      }
    }
  }

  async function handleCircleAction(act, id) {
    const c = state.circles.find((x) => x.id === id);
    if (!c) return;
    switch (act) {
      case "details":
        return openDetails(id);
      case "join":
        return runTx({ key: `join-${id}`, label: `Join circle #${id}`, method: "joinCircle", args: [id], value: c.collateral, circleId: id, action: "joinCircle" });
      case "leave":
        if (!confirm(`Leave "${c.name}"? Your collateral will be credited to your withdrawable balance.`)) return;
        return runTx({ key: `leave-${id}`, label: `Leave circle #${id}`, method: "leaveCircle", args: [id], circleId: id, action: "leaveCircle" });
      case "cancel":
        if (!confirm(`Cancel "${c.name}"? All members' collateral will be refunded.`)) return;
        return runTx({ key: `cancel-${id}`, label: `Cancel circle #${id}`, method: "cancelCircle", args: [id], circleId: id, action: "cancelCircle" });
      case "contribute":
        return runTx({ key: `contribute-${id}`, label: `Pay round ${c.currentRound} of #${id}`, method: "contribute", args: [id], value: c.contribution, circleId: id, action: "contribute" });
      case "settle":
        return runTx({ key: `settle-${id}`, label: `Settle round ${c.currentRound} of #${id}`, method: "settleRound", args: [id], circleId: id, action: "settleRound" });
    }
  }

  // ------------------------------------------------------------------ create form
  function readCreateForm() {
    const f = $("#createForm");
    const errors = {};
    const name = f.name.value.trim();
    const nameBytes = new TextEncoder().encode(name).length;
    if (!name) errors.name = "Name is required.";
    else if (nameBytes > 40) errors.name = `Name is too long (${nameBytes}/40 bytes).`;

    let contribution = null, collateral = null;
    const parseEth = (v) => {
      if (!/^\d*\.?\d{0,18}$/.test(v) || v === "" || v === ".") return null;
      try { return ethers.parseEther(v); } catch (_) { return null; }
    };
    contribution = parseEth(f.contribution.value.trim());
    if (contribution === null) errors.contribution = "Enter a valid ETH amount.";
    else if (contribution < ethers.parseEther("0.0001")) errors.contribution = "Minimum is 0.0001 ETH.";

    const members = Number(f.members.value);
    if (!Number.isInteger(members) || members < 2 || members > 12) errors.members = "Choose between 2 and 12 members.";

    const durationVal = Number(f.duration.value);
    const duration = Math.round(durationVal * Number(f.durationUnit.value));
    if (!Number.isFinite(durationVal) || durationVal <= 0) errors.duration = "Enter a positive duration.";
    else if (duration < 120) errors.duration = "Minimum round duration is 2 minutes.";
    else if (duration > 30 * 86400) errors.duration = "Maximum round duration is 30 days.";

    collateral = parseEth(f.collateral.value.trim());
    if (collateral === null) errors.collateral = "Enter a valid ETH amount.";
    else if (contribution !== null && collateral < contribution) errors.collateral = "Collateral must be ≥ contribution.";

    return { name, contribution, members, duration, collateral, errors };
  }

  function showFormErrors(errors) {
    $$("#createForm .err").forEach((el) => {
      const msg = errors[el.dataset.for] || "";
      el.textContent = msg;
      el.closest(".field").classList.toggle("invalid", !!msg);
    });
  }

  function updateCreateSummary() {
    const { contribution, members, duration, collateral, errors } = readCreateForm();
    const okC = contribution !== null && !errors.contribution;
    const okM = !errors.members;
    $("#sPot").textContent = okC && okM ? `${fmtEth(contribution * BigInt(members), 6)} ETH` : "—";
    $("#sTotal").textContent = okC && okM ? `${fmtEth(contribution * BigInt(members), 6)} ETH over ${members} rounds` : "—";
    $("#sLength").textContent = okM && !errors.duration ? `≈ ${fmtDuration(duration * members)}` : "—";

    if (okC && okM && collateral !== null) {
      // Worst case: the first recipient stops paying for the remaining (members - 1) rounds.
      const worst = contribution * BigInt(members - 1);
      const pct = worst === 0n ? 100 : Number((collateral * 10000n) / worst) / 100;
      const shown = Math.min(pct, 100);
      $("#sCoverage").textContent = `${pct.toFixed(0)}%`;
      const bar = $("#sCoverageBar");
      bar.style.width = `${shown}%`;
      bar.style.background = pct >= 100 ? "var(--success)" : pct >= 50 ? "var(--warning)" : "var(--danger)";
      $("#sCoverageHint").textContent = pct >= 100
        ? "Fully covered: even if a member stops paying right after receiving the pot, honest members are made whole."
        : `Collateral covers ${pct.toFixed(0)}% of the worst-case default (${fmtEth(worst, 6)} ETH). Set ${fmtEth(worst, 6)} ETH for full protection.`;
    } else {
      $("#sCoverage").textContent = "—";
      $("#sCoverageBar").style.width = "0";
      $("#sCoverageHint").textContent = "Enter valid values to see how much of a default the collateral would cover.";
    }
  }

  async function submitCreate(e) {
    e.preventDefault();
    const data = readCreateForm();
    showFormErrors(data.errors);
    if (Object.keys(data.errors).length) {
      toast("Please fix the highlighted fields", "", "error");
      return;
    }
    const btn = $("#createBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    const receipt = await runTx({
      key: "create",
      label: `Create "${data.name}"`,
      method: "createCircle",
      args: [data.name, data.contribution, data.members, data.duration],
      value: data.collateral,
      action: "createCircle",
    });
    btn.disabled = false;
    btn.textContent = "Create circle & lock collateral";
    if (receipt) {
      $("#createForm").reset();
      updateCreateSummary();
      switchTab("mine");
    }
  }

  // ------------------------------------------------------------------ UI bindings
  function switchTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    if (name === "history") loadHistory();
  }

  function bindUI() {
    $("#connectBtn").addEventListener("click", () => (state.account ? switchTab("mine") : connectWallet()));
    $$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    $$("[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
      $$("[data-filter]").forEach((c) => c.classList.toggle("active", c === chip));
      state.filter = chip.dataset.filter;
      renderAll();
    }));
    $$("[data-history]").forEach((chip) => chip.addEventListener("click", () => {
      $$("[data-history]").forEach((c) => c.classList.toggle("active", c === chip));
      state.historyScope = chip.dataset.history;
      loadHistory();
    }));

    $("#refreshBtn").addEventListener("click", () => refreshAll());

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn && !btn.disabled) handleCircleAction(btn.dataset.act, Number(btn.dataset.id));
      if (e.target.closest("[data-close]")) closeModal();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    $("#withdrawBtn").addEventListener("click", () =>
      runTx({ key: "withdraw", label: "Withdraw", method: "withdraw", action: "withdraw" }));

    const form = $("#createForm");
    form.addEventListener("input", () => { updateCreateSummary(); showFormErrors({}); });
    form.addEventListener("submit", submitCreate);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
