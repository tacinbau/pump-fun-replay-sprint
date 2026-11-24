// Late-stage completion hunter for the pump.fun replay (agent-fun/replay/v2).
// No clock, no randomness: decisions are a pure function of the stream.
import { createInterface } from "node:readline";

const SOL = 1_000_000_000n;
const SCALE = 1_000_000n; // price = SOL per token, scaled by 1e6 (bigint math only)
const STAKE = SOL / 20n; // 0.05 SOL per coin
const MIN_BUY = SOL / 80n; // 0.0125 SOL
const MIN_RS = SOL * 40n; // 40 SOL of real reserve: only proven curves
const BUY_WINDOW = 7200; // slots after creation a buy may fire
const STALE_SLOTS = 3600; // slots a flat position may sit before we sell it
const SLIP = 10_000; // wide open

type Curve = {
  cs: number; p0: bigint; pn: bigint; tr: number; by: number;
  rs: bigint; done: boolean; decided: boolean;
  pk: bigint; pt: boolean; p40: bigint;
};

let hello: any = null;
const curves = new Map<string, Curve>();
const pending = new Map<string, { mint: string; side: string; amt: bigint }>();
const heldSince = new Map<string, number>();
let nextId = 0;

// Scaled price: vsol * SCALE / vtok.
const price = (vs: bigint, vt: bigint) => (vs * SCALE) / (vt === 0n ? 1n : vt);
const fresh = (cs: number, p: bigint): Curve => ({
  cs, p0: p, pn: p, tr: 0, by: 0, rs: 0n, done: false, decided: false, pk: 0n, pt: false, p40: 0n,
});

const rl = createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "hello") { hello = m; continue; }
  if (m.type === "done") process.exit(0);
  if (m.type !== "batch") continue;

  const tx = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
  const cash = BigInt(m.account.cash_lamports);
  const pos = new Map<string, { t: bigint; c: bigint }>();
  for (const p of m.account.positions) {
    pos.set(p.mint, { t: BigInt(p.token_amount), c: BigInt(p.cost_lamports) });
  }
  for (const f of m.fills) pending.delete(f.client_id);
  for (const mint of [...heldSince.keys()]) if (!pos.has(mint)) heldSince.delete(mint);
  for (const mint of pos.keys()) if (!heldSince.has(mint)) heldSince.set(mint, m.slot);

  for (const k of m.marks) {
    const c = curves.get(k.mint);
    if (c) c.pn = price(BigInt(k.virtual_quote_reserves), BigInt(k.virtual_token_reserves));
  }
  for (const e of m.events) {
    if (e.event === "CreateEvent") {
      curves.set(e.mint, fresh(e.slot, price(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves))));
    } else if (e.event === "TradeEvent") {
      let c = curves.get(e.mint);
      if (!c) { c = fresh(e.slot, 0n); curves.set(e.mint, c); }
      c.pn = price(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (c.p0 === 0n) c.p0 = c.pn;
      c.rs = BigInt(e.real_quote_reserves);
      if (c.p40 === 0n && c.rs >= MIN_RS) c.p40 = c.pn; // price at first 40-SOL crossing
      c.tr++;
      if (e.is_buy) c.by++;
    } else if (e.event === "CompleteEvent") {
      const c = curves.get(e.mint);
      if (c) c.done = true;
    }
  }

  // Prune dead curves to bound the map.
  if (curves.size > 4000) {
    for (const [mint, c] of curves) {
      if (!pos.has(mint) && (c.done || (c.decided && m.slot - c.cs > BUY_WINDOW))) {
        curves.delete(mint);
      }
    }
  }

  const orders: any[] = [];
  const maxOrd = hello.caps.max_orders_per_batch;
  const pendMints = new Set([...pending.values()].map((o) => o.mint));

  // Exits first.
  for (const [mint, p] of pos) {
    const c = curves.get(mint);
    if (!c || pendMints.has(mint) || orders.length >= maxOrd) continue;
    const entry = (p.c * SCALE) / p.t;
    if (c.pn > c.pk) c.pk = c.pn;
    let sell = 0n;
    if (!c.pt && c.pn >= entry * 2n) { sell = p.t / 2n; c.pt = true; } // bank half at +100%
    else if (c.pn <= (entry * 3n) / 5n) sell = p.t; // stop at -40%; else ride to completion
    else if (c.pk >= entry * 2n && c.pn <= (entry * 3n) / 2n) sell = p.t; // lock +50% after a 2x peak
    else if (m.slot - (heldSince.get(mint) ?? m.slot) > STALE_SLOTS) sell = p.t; // stale
    if (sell > 0n) {
      const id = `o${++nextId}`;
      pending.set(id, { mint, side: "sell", amt: 0n });
      orders.push({ side: "sell", client_id: id, mint, token_amount: sell.toString(), max_slippage_bps: SLIP });
    }
  }

  // Entries: one buy per young, heating-up coin.
  let free = cash;
  for (const o of pending.values()) { free -= tx; if (o.side === "buy") free -= o.amt; }
  const committed = new Set<string>(pos.keys());
  for (const o of pending.values()) if (o.side === "buy") committed.add(o.mint);
  for (const e of m.events) {
    if (orders.length >= maxOrd) break;
    if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
    const c = curves.get(e.mint);
    if (!c || c.done || c.decided || pos.has(e.mint)) continue;
    if (m.slot - c.cs > BUY_WINDOW) { c.decided = true; continue; }
    if (c.tr < 20 || c.by * 20 < c.tr * 11) continue; // >= 20 trades, >= 55% buys
    if (c.p40 === 0n || c.pn > (c.p40 * 23n) / 20n) continue; // buy near the 40-SOL price, not after the spike
    const cap = (c.rs * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10000n;
    if (cap < MIN_BUY) continue; // needs real SOL behind it (cap is 1% of it)
    const amt = cap < STAKE ? cap : STAKE;
    if (committed.size >= hello.caps.max_open_positions || free < amt + tx) continue;
    c.decided = true;
    const id = `o${++nextId}`;
    pending.set(id, { mint: e.mint, side: "buy", amt });
    committed.add(e.mint);
    free -= amt + tx;
    orders.push({ side: "buy", client_id: id, mint: e.mint, quote_lamports: amt.toString(), max_slippage_bps: SLIP });
  }

  process.stdout.write(JSON.stringify({ type: "reply", seq: m.seq, orders }) + "\n");
}
