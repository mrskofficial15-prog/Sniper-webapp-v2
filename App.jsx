import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ComposedChart, Line
} from "recharts";

const SUPABASE_URL = "https://ztopbfibuxfqkwdpphzw.supabase.co";
const DHAN_PROXY = `${SUPABASE_URL}/functions/v1/dhan-proxy`;

const SQUARES = [25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225];

// ---------- Helpers ----------
function fmt(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function isMarketHours() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 3600000);
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  if (day === 0 || day === 6) return false;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function nearestSquare(val) {
  if (val === null || val === undefined) return null;
  let best = null, bestDiff = Infinity;
  for (const sq of SQUARES) {
    const diff = Math.abs(sq - val);
    if (diff < bestDiff) { bestDiff = diff; best = sq; }
  }
  return bestDiff <= 3 ? best : null;
}

// SMC: simple BOS/CHoCH detection from candle closes/highs/lows
function detectSMC(candles) {
  if (!candles || candles.length < 10) return { trend: "SIDEWAYS", events: [] };
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  // find recent swing high/low (last 10 candles excluding last 2)
  const lookback = candles.slice(-12, -2);
  const swingHigh = Math.max(...lookback.map(c => c.high));
  const swingLow = Math.min(...lookback.map(c => c.low));
  const lastClose = closes[closes.length - 1];
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  const events = [];
  let trend = "SIDEWAYS";

  if (lastHigh > swingHigh && lastClose > swingHigh) {
    events.push("BOS↑ (bullish break of structure)");
    trend = "BULLISH";
  } else if (lastLow < swingLow && lastClose < swingLow) {
    events.push("BOS↓ (bearish break of structure)");
    trend = "BEARISH";
  } else if (lastHigh > swingHigh) {
    events.push("CHoCH↑ (potential reversal up)");
    trend = "BULLISH";
  } else if (lastLow < swingLow) {
    events.push("CHoCH↓ (potential reversal down)");
    trend = "BEARISH";
  }

  // FVG detection on last 3 candles
  if (candles.length >= 3) {
    const [a, b, c] = candles.slice(-3);
    if (c.low > a.high) events.push("FVG↑ detected (gap up)");
    if (c.high < a.low) events.push("FVG↓ detected (gap down)");
  }

  return { trend, events };
}

// ---------- Main Component ----------
export default function App() {
  const [connected, setConnected] = useState(false);
  const [clientId, setClientId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connError, setConnError] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [spot, setSpot] = useState(null);
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState("");
  const [chain, setChain] = useState(null);
  const [intraday1h, setIntraday1h] = useState(null);
  const [intraday5m, setIntraday5m] = useState(null);

  const [lastRefresh, setLastRefresh] = useState(null);
  const [countdown, setCountdown] = useState(5);
  const [apiStatus, setApiStatus] = useState("OFFLINE");
  const [errorBanner, setErrorBanner] = useState("");

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);

  // ---------- Connect ----------
  async function handleConnect() {
    setConnError("");
    setConnecting(true);
    try {
      const res = await callDhan(clientId, accessToken, "/v2/marketfeed/quote", "POST", {
        IDX_I: [13],
      });
      if (res.error) {
        setConnError(
          typeof res.message === "string" ? res.message : JSON.stringify(res.message)
        );
        setConnecting(false);
        return;
      }
      localStorage.setItem("tss_clientId", clientId);
      localStorage.setItem("tss_accessToken", accessToken);
      setConnected(true);
      setApiStatus("LIVE");
    } catch (e) {
      setConnError(String(e));
    }
    setConnecting(false);
  }

  function handleDisconnect() {
    localStorage.removeItem("tss_clientId");
    localStorage.removeItem("tss_accessToken");
    setConnected(false);
    setClientId("");
    setAccessToken("");
    setSpot(null);
    setChain(null);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  // restore session
  useEffect(() => {
    const cid = localStorage.getItem("tss_clientId");
    const tok = localStorage.getItem("tss_accessToken");
    if (cid && tok) {
      setClientId(cid);
      setAccessToken(tok);
      setConnected(true);
    }
  }, []);

  // ---------- Dhan proxy call ----------
  async function callDhan(cid, tok, endpoint, method = "GET", payload = null) {
    const res = await fetch(DHAN_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: cid, accessToken: tok, endpoint, method, payload }),
    });
    return res.json();
  }

  // ---------- Fetch all data ----------
  const fetchAll = useCallback(async () => {
    if (!connected) return;
    try {
      // 1. Spot quote
      const quoteRes = await callDhan(clientId, accessToken, "/v2/marketfeed/quote", "POST", { IDX_I: [13] });
      if (quoteRes.error) {
        setApiStatus("OFFLINE");
        setErrorBanner(`Dhan error (${quoteRes.status}): ${JSON.stringify(quoteRes.message)}`);
        return;
      }
      const nifty = quoteRes?.data?.IDX_I?.["13"];
      if (nifty) setSpot(nifty);

      // 2. Expiry list (only if not loaded)
      let expiry = selectedExpiry;
      if (expiries.length === 0) {
        const expRes = await callDhan(clientId, accessToken, "/v2/optionchain/expirylist", "POST", {
          UnderlyingScrip: 13, UnderlyingSeg: "IDX_I",
        });
        if (!expRes.error && expRes?.data?.length) {
          setExpiries(expRes.data);
          expiry = expRes.data[0];
          setSelectedExpiry(expiry);
        }
      }

      // 3. Option chain
      if (expiry) {
        const chainRes = await callDhan(clientId, accessToken, "/v2/optionchain", "POST", {
          UnderlyingScrip: 13, UnderlyingSeg: "IDX_I", Expiry: expiry,
        });
        if (!chainRes.error) setChain(chainRes?.data);
      }

      // 4. Intraday candles 1h
      const h1Res = await callDhan(clientId, accessToken, "/v2/charts/intraday", "POST", {
        securityId: "13", exchangeSegment: "IDX_I", instrument: "INDEX", interval: "60",
        fromDate: new Date(Date.now() - 5 * 24 * 3600000).toISOString().slice(0, 10),
        toDate: new Date().toISOString().slice(0, 10),
      });
      if (!h1Res.error) setIntraday1h(parseCandles(h1Res));

      // 5. Intraday candles 5m
      const m5Res = await callDhan(clientId, accessToken, "/v2/charts/intraday", "POST", {
        securityId: "13", exchangeSegment: "IDX_I", instrument: "INDEX", interval: "5",
        fromDate: new Date().toISOString().slice(0, 10),
        toDate: new Date().toISOString().slice(0, 10),
      });
      if (!m5Res.error) setIntraday5m(parseCandles(m5Res));

      setApiStatus("LIVE");
      setErrorBanner("");
      setLastRefresh(new Date());
    } catch (e) {
      setApiStatus("OFFLINE");
      setErrorBanner(`Network error: ${String(e)}`);
    }
  }, [connected, clientId, accessToken, selectedExpiry, expiries]);

  function parseCandles(res) {
    // Dhan returns arrays: open, high, low, close, volume, timestamp
    const d = res?.data || res;
    if (!d?.close) return null;
    const out = [];
    for (let i = 0; i < d.close.length; i++) {
      out.push({
        time: d.timestamp ? d.timestamp[i] : i,
        open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i],
      });
    }
    return out;
  }

  // ---------- Auto refresh ----------
  useEffect(() => {
    if (!connected) return;
    fetchAll();
    intervalRef.current = setInterval(() => {
      if (document.visibilityState === "visible" && isMarketHours()) {
        fetchAll();
        setCountdown(5);
      }
    }, 5000);
    countdownRef.current = setInterval(() => {
      setCountdown(c => (c > 0 ? c - 1 : 5));
    }, 1000);
    return () => {
      clearInterval(intervalRef.current);
      clearInterval(countdownRef.current);
    };
  }, [connected, fetchAll]);

  // ---------- Derived TSS calculations ----------
  const atmStrike = spot?.last_price ? Math.round(spot.last_price / 50) * 50 : null;

  let otmCE = null, otmPE = null, atmCE = null, atmPE = null, sniperPoint = null;
  let oiRows = [];
  let callWall = null, putWall = null, totalCEOI = 0, totalPEOI = 0;

  if (chain?.oc && atmStrike) {
    const strikes = Object.keys(chain.oc).map(Number).sort((a, b) => a - b);
    const otmCEStrike = atmStrike + 50;
    const otmPEStrike = atmStrike - 50;

    const getRow = (s) => chain.oc[s.toFixed(6)] || chain.oc[s.toString()] || chain.oc[s];

    atmCE = getRow(atmStrike)?.ce;
    atmPE = getRow(atmStrike)?.pe;
    otmCE = getRow(otmCEStrike)?.ce;
    otmPE = getRow(otmPEStrike)?.pe;

    if (otmCE?.last_price !== undefined && otmPE?.last_price !== undefined) {
      sniperPoint = (otmCE.last_price + otmPE.last_price) / 2;
    }

    let maxCEOI = -1, maxPEOI = -1;
    strikes.forEach(s => {
      const row = getRow(s);
      if (!row) return;
      const ceOI = row.ce?.oi || 0;
      const peOI = row.pe?.oi || 0;
      totalCEOI += ceOI;
      totalPEOI += peOI;
      if (ceOI > maxCEOI) { maxCEOI = ceOI; callWall = s; }
      if (peOI > maxPEOI) { maxPEOI = peOI; putWall = s; }
    });

    // build 10 strikes above/below ATM
    const atmIdx = strikes.indexOf(atmStrike);
    const startIdx = Math.max(0, atmIdx - 10);
    const endIdx = Math.min(strikes.length, atmIdx + 11);
    oiRows = strikes.slice(startIdx, endIdx).map(s => ({ strike: s, ...getRow(s) }));
  }

  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : null;
  const pcrBias = pcr === null ? "—" : pcr > 1.2 ? "BULLISH" : pcr < 0.8 ? "BEARISH" : "NEUTRAL";

  const spotBias = spot && spot.last_price !== undefined && spot.close !== undefined
    ? (spot.last_price > spot.close ? "BULLISH" : "BEARISH")
    : "—";

  const ceVsSniper = (atmCE?.last_price !== undefined && sniperPoint !== null)
    ? (atmCE.last_price > sniperPoint ? "ABOVE" : "BELOW") : "—";
  const peVsSniper = (atmPE?.last_price !== undefined && sniperPoint !== null)
    ? (atmPE.last_price > sniperPoint ? "ABOVE" : "BELOW") : "—";

  const smc1h = detectSMC(intraday1h);
  const smc5m = detectSMC(intraday5m);

  // Battle 4-way
  let scenario = "D", confidence = "LOW";
  let signal = "NO TRADE — Wait for clear directional break";
  if (spotBias === "BEARISH" && ceVsSniper === "BELOW" && smc1h.trend === "BEARISH") {
    scenario = "A"; signal = "BUY PE on Supply Zone retest"; confidence = "HIGH";
  } else if (spotBias === "BULLISH" && ceVsSniper === "ABOVE" && smc1h.trend === "BULLISH") {
    scenario = "B"; signal = "BUY CE on Demand Zone retest"; confidence = "HIGH";
  } else if (spotBias === "BULLISH" && ceVsSniper === "BELOW") {
    scenario = "C"; signal = "WAIT — Seller trap active. CE buyers beware."; confidence = "MEDIUM";
  } else if (spotBias === "BEARISH" && ceVsSniper === "ABOVE") {
    scenario = "C"; signal = "WAIT — possible PE trap"; confidence = "MEDIUM";
  }

  const finalSignal = scenario === "A" ? (confidence === "HIGH" ? "STRONG BUY PE" : "BUY PE")
    : scenario === "B" ? (confidence === "HIGH" ? "STRONG BUY CE" : "BUY CE")
    : scenario === "C" ? "WAIT" : "NO TRADE";

  const ceSquare = nearestSquare(atmCE?.last_price);
  const peSquare = nearestSquare(atmPE?.last_price);

  // ============ RENDER ============
  if (!connected) {
    return <ConnectScreen
      clientId={clientId} setClientId={setClientId}
      accessToken={accessToken} setAccessToken={setAccessToken}
      showToken={showToken} setShowToken={setShowToken}
      connError={connError} connecting={connecting}
      onConnect={handleConnect}
    />;
  }

  const marketOpen = isMarketHours();

  return (
    <div style={styles.app}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* TOP BAR */}
      <div style={styles.topBar}>
        <div style={styles.brand}>TAMILSTOCK SNIPER <span style={{ color: COLORS.textSecondary, fontWeight: 400 }}>TERMINAL</span></div>
        <div style={styles.spotDisplay}>
          {spot ? (
            <>
              NIFTY SPOT: <span style={{ color: COLORS.text }}>{fmt(spot.last_price)}</span>{" "}
              <span style={{ color: spot.last_price >= spot.close ? COLORS.bullish : COLORS.bearish }}>
                {spot.last_price >= spot.close ? "▲" : "▼"} {fmt(Math.abs(spot.last_price - spot.close))}
                {" "}({fmt(Math.abs((spot.last_price - spot.close) / spot.close * 100))}%)
              </span>
            </>
          ) : "NIFTY SPOT: —"}
        </div>
        <div style={styles.statusGroup}>
          <span style={{ ...styles.pill, color: apiStatus === "LIVE" ? COLORS.bullish : COLORS.bearish, borderColor: apiStatus === "LIVE" ? COLORS.bullish : COLORS.bearish }}>
            ● DHAN {apiStatus}
          </span>
          <span style={styles.muted}>{lastRefresh ? lastRefresh.toLocaleTimeString("en-IN") : "—"}</span>
          <span style={styles.muted}>[{countdown}s]</span>
          <button style={styles.smallBtn} onClick={fetchAll}>↻</button>
          <button style={styles.smallBtnOutline} onClick={handleDisconnect}>Disconnect</button>
        </div>
      </div>

      {!marketOpen && (
        <div style={styles.marketClosedBanner}>MARKET CLOSED — auto-refresh paused. Showing last available data.</div>
      )}
      {errorBanner && (
        <div style={styles.errorBanner}>⚠ {errorBanner}</div>
      )}

      <div style={styles.grid}>
        {/* LEFT COLUMN */}
        <div style={styles.mainCol}>

          {/* Market Overview */}
          <Panel title="Market Overview">
            {spot ? (
              <div style={styles.statRow}>
                <Stat label="LTP" value={fmt(spot.last_price)} />
                <Stat label="Open" value={fmt(spot.ohlc?.open ?? spot.open)} />
                <Stat label="High" value={fmt(spot.ohlc?.high ?? spot.high)} />
                <Stat label="Low" value={fmt(spot.ohlc?.low ?? spot.low)} />
                <Stat label="Prev Close" value={fmt(spot.close)} />
                <Stat label="Bias" value={spotBias} color={spotBias === "BULLISH" ? COLORS.bullish : spotBias === "BEARISH" ? COLORS.bearish : COLORS.neutral} bold />
              </div>
            ) : <Empty text="Waiting for first data fetch…" />}
          </Panel>

          {/* Expiry + ATM */}
          <Panel title="Expiry &amp; ATM Detector">
            <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <label style={styles.label}>Expiry</label>
                <select style={styles.select} value={selectedExpiry} onChange={e => setSelectedExpiry(e.target.value)}>
                  {expiries.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
              <div style={styles.bigStat}>
                ATM Strike: <span style={{ color: COLORS.accent }}>{atmStrike ?? "—"}</span>
              </div>
            </div>
          </Panel>

          {/* Sniper Point */}
          <Panel title="Sniper Point Calculator — Lakshman Rekha" glow>
            <div style={styles.statRow}>
              <Stat label="OTM CE (ATM+50)" value={otmCE ? `₹${fmt(otmCE.last_price)}` : "—"} />
              <Stat label="OTM PE (ATM-50)" value={otmPE ? `₹${fmt(otmPE.last_price)}` : "—"} />
            </div>
            <div style={styles.sniperBig}>
              SNIPER POINT: <span>{sniperPoint !== null ? `₹${fmt(sniperPoint)}` : "—"}</span>
            </div>
            <div style={styles.statRow}>
              <Stat label="ATM CE vs Sniper" value={ceVsSniper === "ABOVE" ? "ABOVE SNIPER ✅" : ceVsSniper === "BELOW" ? "BELOW SNIPER ❌" : "—"}
                color={ceVsSniper === "ABOVE" ? COLORS.bullish : ceVsSniper === "BELOW" ? COLORS.bearish : COLORS.neutral} />
              <Stat label="ATM PE vs Sniper" value={peVsSniper === "ABOVE" ? "ABOVE SNIPER ✅" : peVsSniper === "BELOW" ? "BELOW SNIPER ❌" : "—"}
                color={peVsSniper === "ABOVE" ? COLORS.bullish : peVsSniper === "BELOW" ? COLORS.bearish : COLORS.neutral} />
            </div>
          </Panel>

          {/* Option Chain */}
          <Panel title="Option Chain">
            {oiRows.length ? (
              <div style={{ overflowX: "auto" }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {["CE LTP", "CE OI", "CE ΔOI", "CE IV", "STRIKE", "PE IV", "PE ΔOI", "PE OI", "PE LTP"].map(h => (
                        <th key={h} style={styles.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {oiRows.map(row => {
                      const isATM = row.strike === atmStrike;
                      const isCallWall = row.strike === callWall;
                      const isPutWall = row.strike === putWall;
                      return (
                        <tr key={row.strike} style={{
                          background: isATM ? "rgba(245,158,11,0.12)" : "transparent",
                        }}>
                          <td style={{ ...styles.td, ...styles.ce, ...(isCallWall ? styles.wall : {}) }}>{fmt(row.ce?.last_price)}</td>
                          <td style={{ ...styles.td, ...styles.ce, ...(isCallWall ? styles.wall : {}) }}>{row.ce?.oi?.toLocaleString("en-IN") ?? "—"}</td>
                          <td style={{ ...styles.td, ...styles.ce }}>{row.ce?.oi_change_value?.toLocaleString("en-IN") ?? "—"}</td>
                          <td style={{ ...styles.td, ...styles.ce }}>{fmt(row.ce?.implied_volatility, 1)}</td>
                          <td style={{ ...styles.td, ...styles.strikeCol, ...(isATM ? styles.atmStrike : {}) }}>{row.strike}</td>
                          <td style={{ ...styles.td, ...styles.pe }}>{fmt(row.pe?.implied_volatility, 1)}</td>
                          <td style={{ ...styles.td, ...styles.pe }}>{row.pe?.oi_change_value?.toLocaleString("en-IN") ?? "—"}</td>
                          <td style={{ ...styles.td, ...styles.pe, ...(isPutWall ? styles.wall : {}) }}>{row.pe?.oi?.toLocaleString("en-IN") ?? "—"}</td>
                          <td style={{ ...styles.td, ...styles.pe, ...(isPutWall ? styles.wall : {}) }}>{fmt(row.pe?.last_price)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={styles.pcrRow}>
                  <span>PCR: <strong style={{ color: COLORS.accent }}>{pcr !== null ? fmt(pcr, 2) : "—"}</strong></span>
                  <span style={{
                    color: pcrBias === "BULLISH" ? COLORS.bullish : pcrBias === "BEARISH" ? COLORS.bearish : COLORS.neutral
                  }}>{pcrBias}</span>
                </div>
              </div>
            ) : <Empty text="No option chain data yet." />}
          </Panel>

          {/* OI Wall Chart */}
          <Panel title="OI Wall Map — Max Pain Zone">
            {oiRows.length ? (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={oiRows.map(r => ({
                    strike: r.strike,
                    CE: (r.ce?.oi || 0) / 100000,
                    PE: (r.pe?.oi || 0) / 100000,
                  }))}>
                    <CartesianGrid stroke="#1f1f1f" />
                    <XAxis dataKey="strike" stroke="#9ca3af" fontSize={11} />
                    <YAxis stroke="#9ca3af" fontSize={11} label={{ value: "OI (Lakhs)", angle: -90, position: "insideLeft", fill: "#9ca3af", fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: "#111", border: "1px solid #1f1f1f", fontFamily: "JetBrains Mono" }} />
                    <Bar dataKey="CE" fill={COLORS.bullish} />
                    <Bar dataKey="PE" fill={COLORS.bearish} />
                    {atmStrike && <ReferenceLine x={atmStrike} stroke={COLORS.accent} strokeDasharray="4 4" label={{ value: "ATM", fill: COLORS.accent, fontSize: 11 }} />}
                  </BarChart>
                </ResponsiveContainer>
                <div style={styles.pcrRow}>
                  <span>CALL WALL: <strong style={{ color: COLORS.bullish }}>{callWall ?? "—"}</strong></span>
                  <span>PUT WALL: <strong style={{ color: COLORS.bearish }}>{putWall ?? "—"}</strong></span>
                  <span>MAX PAIN: <strong style={{ color: COLORS.accent }}>{atmStrike ?? "—"}</strong></span>
                </div>
              </>
            ) : <Empty text="No OI data yet." />}
          </Panel>

          {/* Candle Charts */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 320 }}>
              <Panel title={`1H Candles (HTF) — Trend: ${smc1h.trend}`} accent={smc1h.trend}>
                {intraday1h ? (
                  <>
                    <ResponsiveContainer width="100%" height={200}>
                      <ComposedChart data={intraday1h.slice(-20)}>
                        <CartesianGrid stroke="#1f1f1f" />
                        <XAxis dataKey="time" tick={false} stroke="#9ca3af" />
                        <YAxis stroke="#9ca3af" fontSize={11} domain={["auto", "auto"]} />
                        <Tooltip contentStyle={{ background: "#111", border: "1px solid #1f1f1f", fontFamily: "JetBrains Mono" }} />
                        <Line type="monotone" dataKey="close" stroke={COLORS.accent} dot={false} strokeWidth={1.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    {smc1h.events.map((e, i) => <div key={i} style={styles.smcTag}>{e}</div>)}
                  </>
                ) : <Empty text="No 1H candle data." />}
              </Panel>
            </div>
            <div style={{ flex: 1, minWidth: 320 }}>
              <Panel title={`5M Candles (LTF) — Trend: ${smc5m.trend}`} accent={smc5m.trend}>
                {intraday5m ? (
                  <>
                    <ResponsiveContainer width="100%" height={200}>
                      <ComposedChart data={intraday5m.slice(-40)}>
                        <CartesianGrid stroke="#1f1f1f" />
                        <XAxis dataKey="time" tick={false} stroke="#9ca3af" />
                        <YAxis stroke="#9ca3af" fontSize={11} domain={["auto", "auto"]} />
                        <Tooltip contentStyle={{ background: "#111", border: "1px solid #1f1f1f", fontFamily: "JetBrains Mono" }} />
                        <Line type="monotone" dataKey="close" stroke={COLORS.accent} dot={false} strokeWidth={1.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    {smc5m.events.map((e, i) => <div key={i} style={styles.smcTag}>{e}</div>)}
                  </>
                ) : <Empty text="No 5M candle data." />}
              </Panel>
            </div>
          </div>

          {/* Battle 4-Way */}
          <Panel title="Battle 4-Way Scenario Engine" glow>
            <div style={{
              ...styles.scenarioCard,
              borderColor: scenario === "A" ? COLORS.bearish : scenario === "B" ? COLORS.bullish : scenario === "C" ? COLORS.trap : COLORS.neutral
            }}>
              <div style={styles.scenarioLetter}>{scenario}</div>
              <div style={{ flex: 1 }}>
                <div style={styles.scenarioTitle}>
                  {scenario === "A" ? "BEARISH — TRUE BREAKDOWN"
                    : scenario === "B" ? "BULLISH — TRUE BREAKOUT"
                    : scenario === "C" ? "TRAP — FAKE BREAKOUT"
                    : "SIDEWAYS / NO SETUP"}
                </div>
                <div style={styles.scenarioSignal}>{signal}</div>
                <div style={styles.statRow}>
                  <Stat label="Final Signal" value={finalSignal}
                    color={finalSignal.includes("CE") ? COLORS.bullish : finalSignal.includes("PE") ? COLORS.bearish : COLORS.neutral} bold />
                  <Stat label="Confidence" value={confidence} />
                </div>
              </div>
            </div>
          </Panel>

          {/* Square Numbers */}
          <Panel title="Square Number Levels">
            <div style={{ ...styles.muted, marginBottom: 8 }}>
              {SQUARES.join(", ")}
            </div>
            <div style={styles.statRow}>
              <Stat label="ATM CE" value={atmCE ? `₹${fmt(atmCE.last_price)}${ceSquare ? ` → Near SQ ${ceSquare} ⚠️` : ""}` : "—"}
                color={ceSquare ? COLORS.trap : COLORS.text} />
              <Stat label="ATM PE" value={atmPE ? `₹${fmt(atmPE.last_price)}${peSquare ? ` → Near SQ ${peSquare} ⚠️` : ""}` : "—"}
                color={peSquare ? COLORS.trap : COLORS.text} />
            </div>
          </Panel>
        </div>

        {/* SIDEBAR */}
        <div style={styles.sidebar}>
          <Panel title="TSS Rules">
            <ul style={styles.rulesList}>
              <li>⛔ No trade 09:15–09:30 (wait for opening range)</li>
              <li>⚠️ Caution 13:30–14:00 (Europe open volatility)</li>
              <li>🚫 No OTM trades after 14:30</li>
              <li>📍 Watch LOCATION not just price</li>
              <li>✅ Max 1–2 trades per day</li>
              <li>✅ Single direction only — no hedging</li>
              <li>🎯 Entry window: 09:30–09:45 for best setups</li>
              <li>📊 Max position: 15–20 lots</li>
              <li>💤 Doing NOTHING is also a valid trade</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ---------- Connect Screen ----------
function ConnectScreen({ clientId, setClientId, accessToken, setAccessToken, showToken, setShowToken, connError, connecting, onConnect }) {
  return (
    <div style={styles.connectWrap}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
      <div style={styles.connectCard}>
        <div style={styles.connectTitle}>TamilStock Sniper Terminal</div>
        <div style={styles.connectSubtitle}>TSS + SMC Intraday Engine</div>

        <label style={styles.label}>Dhan Client ID</label>
        <input style={styles.input} value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1100xxxxxx" />

        <label style={styles.label}>Dhan Access Token</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...styles.input, flex: 1 }}
            type={showToken ? "text" : "password"}
            value={accessToken}
            onChange={e => setAccessToken(e.target.value)}
            placeholder="eyJ0eXAiOiJKV1Qi..."
          />
          <button style={styles.smallBtnOutline} onClick={() => setShowToken(s => !s)}>{showToken ? "Hide" : "Show"}</button>
        </div>

        {connError && <div style={styles.errorBanner}>⚠ {connError}</div>}

        <button style={styles.runBtn} onClick={onConnect} disabled={connecting || !clientId || !accessToken}>
          {connecting ? "CONNECTING…" : "Connect to Dhan"}
        </button>

        <div style={styles.connectNote}>
          Credentials stored only in this browser's localStorage. Sent only via the Supabase proxy to api.dhan.co.
        </div>
      </div>
    </div>
  );
}

// ---------- Small components ----------
function Panel({ title, children, glow, accent }) {
  const borderColor = accent === "BULLISH" ? COLORS.bullish : accent === "BEARISH" ? COLORS.bearish : COLORS.border;
  return (
    <div style={{
      ...styles.panel,
      ...(glow ? { boxShadow: "0 0 20px rgba(245,158,11,0.15)", borderColor: COLORS.accent } : {}),
      ...(accent ? { borderColor } : {}),
    }}>
      <div style={styles.panelTitle}>{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, color, bold }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color: color || COLORS.text, fontWeight: bold ? 700 : 500 }}>{value}</div>
    </div>
  );
}

function Empty({ text }) {
  return <div style={styles.empty}>{text}</div>;
}

// ---------- Theme ----------
const COLORS = {
  bg: "#0a0a0a",
  surface: "#111111",
  border: "#1f1f1f",
  accent: "#f59e0b",
  bullish: "#22c55e",
  bearish: "#ef4444",
  trap: "#f97316",
  neutral: "#6b7280",
  text: "#f5f5f5",
  textSecondary: "#9ca3af",
};

const mono = "'JetBrains Mono', monospace";
const sans = "'Inter', sans-serif";

const styles = {
  app: {
    background: COLORS.bg, color: COLORS.text, minHeight: "100vh",
    fontFamily: sans, padding: 16,
  },
  topBar: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    flexWrap: "wrap", gap: 12, borderBottom: `1px solid ${COLORS.border}`,
    paddingBottom: 12, marginBottom: 16,
  },
  brand: { fontFamily: mono, fontWeight: 700, fontSize: 18, letterSpacing: 1, color: COLORS.accent },
  spotDisplay: { fontFamily: mono, fontSize: 15, color: COLORS.textSecondary },
  statusGroup: { display: "flex", alignItems: "center", gap: 10, fontFamily: mono, fontSize: 12 },
  pill: {
    border: "1px solid", borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 600,
  },
  muted: { color: COLORS.textSecondary },
  smallBtn: {
    background: "transparent", border: `1px solid ${COLORS.border}`, color: COLORS.text,
    borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontFamily: mono,
  },
  smallBtnOutline: {
    background: "transparent", border: `1px solid ${COLORS.accent}`, color: COLORS.accent,
    borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontFamily: mono, fontSize: 12,
  },
  marketClosedBanner: {
    background: "rgba(245,158,11,0.1)", border: `1px solid ${COLORS.accent}`, color: COLORS.accent,
    padding: "8px 14px", borderRadius: 4, marginBottom: 12, fontFamily: mono, fontSize: 12,
  },
  errorBanner: {
    background: "rgba(239,68,68,0.1)", border: `1px solid ${COLORS.bearish}`, color: COLORS.bearish,
    padding: "8px 14px", borderRadius: 4, marginBottom: 12, fontFamily: mono, fontSize: 12,
  },
  grid: {
    display: "grid", gridTemplateColumns: "1fr 280px", gap: 16,
  },
  mainCol: { display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
  sidebar: { display: "flex", flexDirection: "column", gap: 16 },
  panel: {
    background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 16,
  },
  panelTitle: {
    fontFamily: mono, fontSize: 12, fontWeight: 600, letterSpacing: 1.5,
    color: COLORS.accent, textTransform: "uppercase", marginBottom: 12,
    borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 8,
  },
  statRow: { display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8 },
  stat: { minWidth: 100 },
  statLabel: { fontSize: 11, color: COLORS.textSecondary, fontFamily: mono, marginBottom: 2 },
  statValue: { fontSize: 15, fontFamily: mono },
  bigStat: { fontFamily: mono, fontSize: 16 },
  label: { display: "block", fontSize: 11, color: COLORS.textSecondary, fontFamily: mono, marginBottom: 4, marginTop: 8 },
  select: {
    background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.text,
    borderRadius: 4, padding: "6px 10px", fontFamily: mono, fontSize: 12,
  },
  input: {
    width: "100%", background: COLORS.bg, border: `1px solid ${COLORS.border}`, color: COLORS.text,
    borderRadius: 4, padding: "8px 10px", fontFamily: mono, fontSize: 13, marginBottom: 4,
  },
  sniperBig: {
    fontFamily: mono, fontSize: 28, fontWeight: 700, color: COLORS.accent,
    margin: "12px 0", textShadow: "0 0 16px rgba(245,158,11,0.4)",
  },
  table: { width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 11, borderRadius: 0 },
  th: {
    border: `1px solid ${COLORS.border}`, padding: "6px 8px", color: COLORS.textSecondary,
    textAlign: "center", background: COLORS.bg, borderRadius: 0,
  },
  td: { border: `1px solid ${COLORS.border}`, padding: "5px 8px", textAlign: "right", borderRadius: 0 },
  ce: { color: COLORS.bullish },
  pe: { color: COLORS.bearish },
  strikeCol: { textAlign: "center", color: COLORS.text, fontWeight: 600 },
  atmStrike: { color: COLORS.accent, background: "rgba(245,158,11,0.15)" },
  wall: { background: "rgba(59,130,246,0.15)", boxShadow: "inset 0 0 0 1px rgba(59,130,246,0.4)" },
  pcrRow: { display: "flex", gap: 24, marginTop: 10, fontFamily: mono, fontSize: 13 },
  smcTag: {
    fontFamily: mono, fontSize: 11, color: COLORS.accent, marginTop: 6,
    border: `1px dashed ${COLORS.border}`, padding: "3px 8px", borderRadius: 4, display: "inline-block", marginRight: 6,
  },
  scenarioCard: {
    display: "flex", gap: 16, alignItems: "flex-start", border: "1px solid", borderRadius: 6, padding: 16,
  },
  scenarioLetter: {
    fontFamily: mono, fontSize: 40, fontWeight: 700, color: COLORS.accent,
    minWidth: 56, textAlign: "center",
  },
  scenarioTitle: { fontFamily: mono, fontSize: 14, fontWeight: 700, marginBottom: 4, color: COLORS.text },
  scenarioSignal: { fontFamily: mono, fontSize: 13, color: COLORS.textSecondary, marginBottom: 8 },
  rulesList: {
    fontFamily: mono, fontSize: 12, lineHeight: 2, color: COLORS.textSecondary,
    listStyle: "none", padding: 0, margin: 0,
  },
  runBtn: {
    background: COLORS.accent, color: "#000", border: "none", borderRadius: 4,
    padding: "10px 20px", fontFamily: mono, fontWeight: 700, fontSize: 13,
    letterSpacing: 1, cursor: "pointer", width: "100%", marginTop: 8,
  },
  aiOutput: {
    background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 4,
    padding: 14, marginTop: 12, fontFamily: mono, fontSize: 12, whiteSpace: "pre-wrap",
    color: COLORS.text, maxHeight: 400, overflowY: "auto",
  },
  empty: { fontFamily: mono, fontSize: 12, color: COLORS.textSecondary, padding: "12px 0" },
  connectWrap: {
    background: COLORS.bg, minHeight: "100vh", display: "flex", alignItems: "center",
    justifyContent: "center", fontFamily: sans, padding: 16,
  },
  connectCard: {
    background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 6,
    padding: 32, width: "100%", maxWidth: 420,
  },
  connectTitle: { fontFamily: mono, fontSize: 22, fontWeight: 700, color: COLORS.accent, marginBottom: 4 },
  connectSubtitle: { fontFamily: mono, fontSize: 12, color: COLORS.textSecondary, marginBottom: 20 },
  connectNote: { fontFamily: mono, fontSize: 10, color: COLORS.textSecondary, marginTop: 12, lineHeight: 1.6 },
};
