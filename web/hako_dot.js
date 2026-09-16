// 姿（決定 27）。卵と、鍵からのドット絵。hako_avatar.py の dot_* の写し。
// 規則は 1 行ずつ:
//   1. 卵（鍵がまだ無い）は EGG ひとつだけ。誰の DID でもないので個体差は出さない
//   2. 鍵があるときは輪郭の箱。中は空で、そこに模様。顔は輪郭と同じ色で中に描く（決定 27-3）
//   3. 割り当ては b0 色・b1 飾り・b4 目の間隔・b8 体つき・b9 目・b10 口・b11 模様・b12 足
//   4. 1 体は 1 つの <path> として塗る。マスの境目（ドットの枠線）は出さない（決定 27-2）
//   5. 眠るときだけ、目の形にかかわらず二本線にする
// Python と同じ姿が出ることは tests/test_dot_js.py が node で突き合わせる。

export const PALETTE = ["#f07c7c","#3b8cff","#f0ede6","#5ec99a","#f5a3b5","#f2cf6b",
                        "#f5a06e","#a394ee","#6fc9dc","#c4d977","#c9a181","#e0e0e0"];

// 卵。06（たまごっち寄りの個体画面）の素体そのまま
export const EGG = [
  "  ############  ",
  " ############## ",
  "################",
  "##            ##",
  "##  ##    ##  ##",
  "##  ##    ##  ##",
  "##            ##",
  "##            ##",
  "##            ##",
  "################",
  " ############## ",
  "  ############  ",
  "   ##      ##   ",
  "   ##      ##   ",
];

export const DOT_BODY = ["square", "tall", "wide", "small"];
export const DOT_BODY_WH = {square: [14, 12], tall: [12, 16], wide: [18, 13], small: [11, 12]};
export const DOT_EYES = ["line", "round", "dot", "smiley", "sleepy", "shine"];
export const DOT_MOUTHS = ["none", "flat", "smile", "small", "open"];
export const DOT_PATTERNS = ["plain", "stripe", "dot", "check", "band"];
export const DOT_LEGS = ["short", "long", "float"];

export function dotAccessoryOf(b1) {
  if (b1 < 85) return null;
  if (b1 >= 248) return "crown";
  return ["sprout", "antenna", "ribbon", "horn"][Math.min(Math.floor((b1 - 85) / 41), 3)];
}

export function dotDerive(pub) {
  return {color: PALETTE[pub[0] % 12], accessory: dotAccessoryOf(pub[1]),
          eye_gap: pub[4] % 3, body: DOT_BODY[pub[8] % 4], eye: DOT_EYES[pub[9] % 6],
          mouth: DOT_MOUTHS[pub[10] % 5], pattern: DOT_PATTERNS[pub[11] % 5],
          leg: DOT_LEGS[pub[12] % 3]};
}

const put = (g, r, c, ch = "#") => { if (g[r] && c >= 0 && c < g[r].length) g[r][c] = ch; };

function outline(bw, bh) {
  const g = Array.from({length: bh}, () => Array(bw).fill(" "));
  for (let r = 0; r < bh; r++) for (let c = 0; c < bw; c++) {
    const edge = r === 0 || r === bh - 1 || c === 0 || c === bw - 1;
    const corner = (r === 0 || r === bh - 1) && (c === 0 || c === bw - 1);
    if (edge && !corner) g[r][c] = "#";
  }
  return g;
}

function pattern(g, kind, bw, bh) {
  if (kind === "plain") return;
  const top = 2, bot = bh - 3;
  if (kind === "check") {
    for (let r = 2; r < bh - 2; r++) for (let c = 2; c < bw - 2; c++) if ((r + c) % 2 === 0) g[r][c] = "#";
    return;
  }
  const rows = {stripe: [top, bot], dot: [top, bot], band: [bot, Math.min(bh - 2, bot + 1)]}[kind];
  for (const r of rows) for (let c = 2; c < bw - 2; c++) {
    if (kind === "dot" && c % 3 !== 2) continue;
    g[r][c] = "#";
  }
}

function eyeCols(bw, gap) {
  const cl = bw % 2 === 0 ? bw / 2 - 1 : (bw - 1) / 2;
  const cr = bw % 2 === 0 ? bw / 2 : (bw - 1) / 2;
  const half = Math.max(1, Math.min(1 + gap, cl - 3));
  return [cl - half - 1, cr + half, cl, cr];
}

function eyes(g, kind, bw, gap, ey) {
  const [lx, rx, cl, cr] = eyeCols(bw, gap);
  if (kind === "smiley") {
    const hs = Math.max(1, Math.min(1 + gap, cl - 4));
    for (const x1 of [cl - hs - 2, cr + hs]) {
      put(g, ey + 1, x1); put(g, ey + 1, x1 + 2); put(g, ey, x1 + 1);
    }
    return;
  }
  for (const [side, x0] of [["L", lx], ["R", rx]]) {
    const outC = side === "L" ? x0 : x0 + 1;
    const inC = side === "L" ? x0 + 1 : x0;
    if (kind === "line") { put(g, ey, x0); put(g, ey, x0 + 1); }
    else if (kind === "round") { for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) put(g, ey + r, x0 + c); }
    else if (kind === "dot") put(g, ey, inC);
    else if (kind === "sleepy") { put(g, ey, x0); put(g, ey, x0 + 1); put(g, ey + 1, outC); }
    else if (kind === "shine") {
      for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) put(g, ey + r, x0 + c);
      put(g, ey, inC, " ");
    }
  }
}

function mouth(g, kind, bw, my) {
  const [, , cl, cr] = eyeCols(bw, 0);
  if (kind === "flat") { put(g, my - 1, cl); put(g, my - 1, cr); put(g, my, cl - 1); put(g, my, cr + 1); }
  else if (kind === "smile") { put(g, my, cl); put(g, my, cr); put(g, my - 1, cl - 1); put(g, my - 1, cr + 1); }
  else if (kind === "small") { put(g, my, cl); put(g, my, cr); }
  else if (kind === "open") for (const r of [my - 1, my]) for (let c = cl; c <= cr; c++) put(g, r, c);
}

function clearFace(g, bw, bh, gap, ey, my) {
  const [lx, rx] = eyeCols(bw, gap);
  for (let r = ey - 1; r <= my + 1; r++) for (let c = lx - 1; c <= rx + 2; c++)
    if (r >= 1 && r <= bh - 2 && c >= 1 && c <= bw - 2) put(g, r, c, " ");
}

function legs(g, kind, bw) {
  if (kind === "float") return g;
  const cols = [2, 3, bw - 4, bw - 3].filter(c => c >= 0 && c < bw);
  for (let i = 0; i < (kind === "short" ? 1 : 2); i++) {
    const row = Array(bw).fill(" ");
    for (const c of cols) row[c] = "#";
    g.push(row);
  }
  return g;
}

function accRows(acc, bw) {
  const m = Math.floor(bw / 2);
  const row = (...cols) => { const r = Array(bw).fill(" "); for (const c of cols) if (c >= 0 && c < bw) r[c] = "#"; return r; };
  const range = (a, b) => Array.from({length: b - a}, (_, i) => a + i);
  return {null: [], sprout: [row(m), row(m - 1, m, m + 1)],
          antenna: [row(m - 2, m + 2), row(m - 1, m, m + 1)],
          ribbon: [row(m - 3, m - 2, m + 2, m + 3), row(m - 1, m, m + 1)],
          horn: [row(1, bw - 2), row(1, 2, bw - 3, bw - 2)],
          crown: [row(2, m, bw - 3), row(...range(2, bw - 2))]}[acc === null ? "null" : acc];
}

export function dotRows(pub, over = {}) {
  const d = Object.assign(dotDerive(pub), over);
  if (over.sleeping) d.eye = "line";
  const [bw, bh] = DOT_BODY_WH[d.body];
  const g = outline(bw, bh);
  const ey = Math.max(2, Math.floor(bh / 2) - 2);
  const my = Math.min(bh - 2, ey + 3);
  pattern(g, d.pattern, bw, bh);
  clearFace(g, bw, bh, d.eye_gap, ey, my);
  eyes(g, d.eye, bw, d.eye_gap, ey);
  mouth(g, d.mouth, bw, my);
  legs(g, d.leg, bw);
  const top = accRows(d.accessory, bw);
  let rows = top.concat(g).map(r => r.join(""));
  const wmax = Math.max(...rows.map(r => r.length));
  const pad = Array(Math.max(0, 2 - top.length)).fill(" ".repeat(wmax));
  rows = pad.concat(rows.map(r => r.padEnd(wmax, " ")));
  return [rows, d];
}

export function dotPath(x, y, rows, px, color) {
  const d = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let c = 0;
    while (c < row.length) {
      const ch = row[c];
      let run = 1;
      while (c + run < row.length && row[c + run] === ch) run++;
      if (ch === "#") {
        const x0 = x + c * px, y0 = y + r * px, w = run * px;
        d.push(`M${x0.toFixed(2)} ${y0.toFixed(2)}h${w.toFixed(2)}v${px.toFixed(2)}h${(-w).toFixed(2)}z`);
      }
      c += run;
    }
  }
  return d.length ? `<path d="${d.join("")}" fill="${color}" shape-rendering="crispEdges"/>` : "";
}

const svgWrap = (rows, px, inner) => {
  const w = rows[0].length * px, h = rows.length * px;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${inner}</svg>`;
};

export function eggSvg(px = 8, color = PALETTE[2]) {
  return svgWrap(EGG, px, dotPath(0, 0, EGG, px, color));
}

export function dotSvg(pub, px = 8, over = {}) {
  const [rows, d] = dotRows(pub, over);
  return svgWrap(rows, px, dotPath(0, 0, rows, px, d.color));
}

// did:key:z6Mk… → 公開鍵 32 バイト（0xed01 ＋ 32 バイトの base58btc）
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function pubFromDid(did) {
  const s = String(did).replace(/^did:key:z/, "");
  let n = 0n;
  for (const ch of s) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw new Error("not base58btc");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch === "1") out.unshift(0); else break; }
  if (out.length !== 34 || out[0] !== 0xed || out[1] !== 0x01) throw new Error("not an ed25519 did:key");
  return Uint8Array.from(out.slice(2));
}
