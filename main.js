// SWARM DARTS — 中濱Games
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { initNet } from './net.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無視 */ } },
};

// ---------- 定数 ----------
const LANE = 3.2;           // 左右の移動範囲（コース）
const BOARD_R = 6;          // ボードの得点エリア半径
const BOARD_Y = 1.2;
const MAXV = 260;           // 実際に描画するダーツの最大本数
const MAXDEBRIS = 140;
const LAYOUT = 0.22;        // 群れ（球状）の密度
const TRACK_Y = -1.6;       // コース床の高さ
const ROW_Y = [TRACK_Y + 4.05, TRACK_Y + 1.45];   // ゲートの上段・下段の高さ
const SPLIT_Y = TRACK_Y + 2.75;                   // 上下の境目
const Y_MIN = TRACK_Y + 0.75, Y_MAX = TRACK_Y + 4.85;
const RUN_SPEED = 20;
const APPROACH_SPEED = 13;
const APPROACH_LEN = 34;
const GATE_GAP = 34;
const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const RING = { bullIn: 0.1, bullOut: 0.2, triIn: 0.5, triOut: 0.6, dblIn: 0.9 };

// ---------- ユーティリティ ----------
const rand = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (k, dt) => 1 - Math.exp(-k * dt);
// コース生成用のシード付き乱数（対戦では全員が同じコースになる）
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = Math.random;
const crand = (a, b) => a + rng() * (b - a);
const cri = (a, b) => Math.floor(crand(a, b + 1));

function fmtJP(n) {
  n = Math.floor(n);
  const units = [[1e16, '京'], [1e12, '兆'], [1e8, '億'], [1e4, '万']];
  for (const [v, u] of units) {
    if (n >= v) {
      const x = n / v;
      let s = x >= 1000 ? Math.floor(x).toLocaleString() : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
      if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return s + u;
    }
  }
  return n.toLocaleString();
}

function niceFloor(n) {
  if (n < 100) return Math.max(10, Math.floor(n / 10) * 10);
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / p) * p;
}

// ---------- サウンド ----------
let ac = null;
let muted = store.get('sd_muted', false);
function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; } }
  if (ac && ac.state === 'suspended') ac.resume();
}
function tone(f, d = 0.12, type = 'sine', v = 0.12, slide = 0, delay = 0) {
  if (!ac || muted) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f * slide), t + d);
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + d + 0.03);
}
const sfx = {
  good() { tone(520, 0.12, 'triangle', 0.14, 1.6); tone(780, 0.14, 'triangle', 0.1, 1.5, 0.06); },
  bad() { tone(220, 0.25, 'sawtooth', 0.09, 0.5); },
  hitObstacle() { tone(140, 0.2, 'square', 0.1, 0.4); },
  thud() { tone(90, 0.35, 'sine', 0.35, 0.4); tone(1200, 0.5, 'triangle', 0.08, 1.2, 0.08); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, 1, i * 0.1)); },
  lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.3, 'triangle', 0.1, 1, i * 0.15)); },
};

// ---------- レンダラー / シーン ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = (() => {
  const c = document.createElement('canvas'); c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#04061a'); grd.addColorStop(0.45, '#151a4a'); grd.addColorStop(0.62, '#3a1f66');
  grd.addColorStop(0.72, '#1a1748'); grd.addColorStop(1, '#070a1e');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
scene.fog = new THREE.Fog(0x1a1748, 40, 190);
let fovKick = 0, baseFov = 62, shake = 0;

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 500);
camera.position.set(0, 3.5, 9);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // 縦長スマホでもコースの左右が見えるように視野角を調整
  const base = Math.tan(THREE.MathUtils.degToRad(31));
  const need = 0.42 / camera.aspect;
  baseFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(base, need)));
  camera.fov = baseFov + fovKick;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x2a1640, 0.85));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
sun.position.set(5, 12, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 60 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
// 輪郭を立たせるリムライト（ピンク / シアン）
const rimA = new THREE.DirectionalLight(0xff4fa0, 1.4); rimA.position.set(-6, 3, -10); scene.add(rimA);
const rimB = new THREE.DirectionalLight(0x3fd8ff, 1.1); rimB.position.set(7, -2, -8); scene.add(rimB);

// 星空（カメラに追従）
const stars = (() => {
  const n = 900, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(rand(120, 200));
    v.y = Math.abs(v.y) * 0.8 - 10;
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.9, sizeAttenuation: true, fog: false }));
  scene.add(p);
  return p;
})();

// 床グリッド
const grid = new THREE.GridHelper(300, 120, 0x4a5cff, 0x1d2a6a);
grid.position.y = -18;          // はるか下の地面（奥行き感）
grid.material.transparent = true;
grid.material.opacity = 0.4;
scene.add(grid);

// 空中に浮かぶブロック（左右を流れて奥行きを出す）
const FB = 80;
const floaters = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.25, emissive: 0x111133 }),
  FB
);
floaters.frustumCulled = false;
scene.add(floaters);
const floatData = [];
const FLOAT_COLORS = [0x3fa9ff, 0xff3d7f, 0xffd23d, 0x7a5cff, 0x2fe0b0, 0x2b3570, 0x2b3570];
function resetFloater(f, zBase) {
  const side = Math.random() < 0.5 ? -1 : 1;
  f.x = side * rand(13, 40); f.y = rand(-15, 13); f.z = zBase - rand(0, 170);
  f.s = rand(1, 4.8); f.sy = f.s * rand(0.6, 2.8);
  f.rx = rand(0, 6); f.ry = rand(0, 6); f.w = rand(-0.5, 0.5);
}
for (let i = 0; i < FB; i++) {
  const f = {}; resetFloater(f, 30); floatData.push(f);
  floaters.setColorAt(i, new THREE.Color(FLOAT_COLORS[i % FLOAT_COLORS.length]));
}

// はじける3Dパーティクル
const BMAX = 260;
const burstMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color: 0xffffff }), BMAX);
burstMesh.frustumCulled = false;
burstMesh.setColorAt(0, new THREE.Color(0xffffff));
burstMesh.count = 0;
scene.add(burstMesh);
const bursts = [];
function burst(x, y, z, color, n = 40, spd = 8, follow = 0) {
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    if (bursts.length >= BMAX) bursts.shift();
    const v = new THREE.Vector3().randomDirection().multiplyScalar(rand(spd * 0.35, spd));
    v.z -= follow;
    bursts.push({ p: new THREE.Vector3(x, y, z), v, life: rand(0.5, 1.0), c, r: rand(0, 6) });
  }
}

// スピード線
const LN = 150;
const lineData = [];
const linePos = new Float32Array(LN * 6);
const lineGeo = new THREE.BufferGeometry();
lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
const speedLines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.45 }));
speedLines.frustumCulled = false;
scene.add(speedLines);
function resetLine(l, zBase) {
  l.x = rand(-15, 15);
  l.y = rand(-5, 11);
  if (Math.abs(l.x) < 4.5 && l.y > -2.5 && l.y < 4.5) l.x += (l.x < 0 ? -1 : 1) * 5;
  l.z = zBase - rand(0, 100);
  l.len = rand(1.5, 4.5);
}
for (let i = 0; i < LN; i++) { const l = {}; resetLine(l, 10); lineData.push(l); }

// ---------- ダーツのモデル ----------
function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const dartGeo = (() => {
  const tip = colored(new THREE.ConeGeometry(0.035, 0.28, 8), 0xe6edf7);
  tip.rotateX(-Math.PI / 2); tip.translate(0, 0, -0.42);
  const barrel = colored(new THREE.CylinderGeometry(0.065, 0.05, 0.34, 10), 0xffc93d);
  barrel.rotateX(-Math.PI / 2); barrel.translate(0, 0, -0.12);
  const shaft = colored(new THREE.CylinderGeometry(0.025, 0.025, 0.36, 6), 0x2b2f45);
  shaft.rotateX(-Math.PI / 2); shaft.translate(0, 0, 0.2);
  const f1 = colored(new THREE.BoxGeometry(0.34, 0.014, 0.24), 0xff3d7f); f1.translate(0, 0, 0.34);
  const f2 = colored(new THREE.BoxGeometry(0.014, 0.34, 0.24), 0x3fa9ff); f2.translate(0, 0, 0.34);
  const g = mergeGeometries([tip, barrel, shaft, f1, f2]);
  g.scale(1.05, 1.05, 1.05);
  return g;
})();
const dartMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.35 });
const dartMesh = new THREE.InstancedMesh(dartGeo, dartMat, MAXV + MAXDEBRIS);
dartMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
dartMesh.frustumCulled = false;
dartMesh.count = 0;
dartMesh.castShadow = true;
scene.add(dartMesh);

// 対戦相手の群れ（半透明のゴースト）
const GPER = 24, GMAX = GPER * 8;
const ghostMesh = new THREE.InstancedMesh(dartGeo, new THREE.MeshStandardMaterial({
  color: 0xffffff, transparent: true, opacity: 0.55, roughness: 0.4, metalness: 0.2, depthWrite: false,
}), GMAX);
ghostMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
ghostMesh.setColorAt(0, new THREE.Color(0xffffff));
ghostMesh.frustumCulled = false;
ghostMesh.count = 0;
scene.add(ghostMesh);
const GBALL = Array.from({ length: GPER }, (_, i) => {
  const r = Math.cbrt((i + 0.5) / GPER);
  const yy = 1 - 2 * ((i * 0.618034) % 1);
  const rr = Math.sqrt(1 - yy * yy), a = i * 2.39996;
  return new THREE.Vector3(Math.cos(a) * rr * r, yy * r, Math.sin(a) * rr * r * 1.3);
});
let ghosts = [];
const ghostState = new Map();

// ---------- ダーツボード ----------
function boardTexture() {
  const size = 1024, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, full = size / 2, px = full / (BOARD_R * 1.18), R = BOARD_R * px;
  g.fillStyle = '#101018';
  g.beginPath(); g.arc(cx, cx, full, 0, Math.PI * 2); g.fill();
  const seg = Math.PI / 10;
  const wedge = (r0, r1, a0, a1, col) => {
    g.fillStyle = col;
    g.beginPath(); g.arc(cx, cx, r1, a0, a1); g.arc(cx, cx, r0, a1, a0, true); g.closePath(); g.fill();
  };
  for (let i = 0; i < 20; i++) {
    const mid = -Math.PI / 2 + i * seg, a0 = mid - seg / 2, a1 = mid + seg / 2;
    const odd = i % 2 === 1;
    wedge(0, R, a0, a1, odd ? '#f1e3bf' : '#1a1a1f');
    wedge(R * RING.triIn, R * RING.triOut, a0, a1, odd ? '#1f9d55' : '#e2363b');
    wedge(R * RING.dblIn, R, a0, a1, odd ? '#1f9d55' : '#e2363b');
    // 番号
    g.save();
    g.fillStyle = '#ffffff';
    g.font = `900 ${Math.round(px * 0.62)}px "M PLUS Rounded 1c", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const tr = R * 1.09;
    g.translate(cx + Math.cos(mid) * tr, cx + Math.sin(mid) * tr);
    g.rotate(mid + Math.PI / 2);
    g.fillText(String(SECTORS[i]), 0, 0);
    g.restore();
  }
  g.fillStyle = '#1f9d55'; g.beginPath(); g.arc(cx, cx, R * RING.bullOut, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e2363b'; g.beginPath(); g.arc(cx, cx, R * RING.bullIn, 0, Math.PI * 2); g.fill();
  // ワイヤー
  g.strokeStyle = 'rgba(210,215,230,0.7)'; g.lineWidth = 2;
  for (const r of [RING.bullIn, RING.bullOut, RING.triIn, RING.triOut, RING.dblIn, 1]) {
    g.beginPath(); g.arc(cx, cx, R * r, 0, Math.PI * 2); g.stroke();
  }
  for (let i = 0; i < 20; i++) {
    const a = -Math.PI / 2 + i * seg - seg / 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R * RING.bullOut, cx + Math.sin(a) * R * RING.bullOut);
    g.lineTo(cx + Math.cos(a) * R, cx + Math.sin(a) * R);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const board = new THREE.Group();
let boardFace;
function buildBoard() {
  boardFace = new THREE.Mesh(
    new THREE.CircleGeometry(BOARD_R * 1.18, 128),
    new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.85 })
  );
  boardFace.receiveShadow = true;
  board.add(boardFace);
  const back = new THREE.Mesh(
    new THREE.CylinderGeometry(BOARD_R * 1.26, BOARD_R * 1.3, 1.8, 72),
    new THREE.MeshStandardMaterial({ color: 0x1b1b26, roughness: 0.5, metalness: 0.3 })
  );
  back.rotation.x = Math.PI / 2; back.position.z = -0.92;
  back.castShadow = true;
  board.add(back);
  // 盛り上がったワイヤー
  const wireMat = new THREE.MeshStandardMaterial({ color: 0xdfe4ef, metalness: 0.9, roughness: 0.25 });
  for (const r of [RING.bullIn, RING.bullOut, RING.triIn, RING.triOut, RING.dblIn, 1]) {
    const w = new THREE.Mesh(new THREE.TorusGeometry(BOARD_R * r, 0.035, 6, 160), wireMat);
    w.position.z = 0.03;
    board.add(w);
  }
  // 外周の金属リングと光るリング
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(BOARD_R * 1.24, 0.32, 16, 140),
    new THREE.MeshStandardMaterial({ color: 0x9aa3c0, metalness: 0.9, roughness: 0.3 })
  );
  rim.castShadow = true;
  board.add(rim);
  const glow = new THREE.Mesh(
    new THREE.TorusGeometry(BOARD_R * 1.34, 0.12, 12, 140),
    new THREE.MeshBasicMaterial({ color: 0x3fd8ff })
  );
  glow.position.z = -0.6;
  board.add(glow);
  board.position.y = BOARD_Y;
  scene.add(board);
}

function scoreAt(x, y) {
  const r = Math.hypot(x, y) / BOARD_R;
  if (r > 1) return { pts: 0, kind: 'miss' };
  if (r < RING.bullIn) return { pts: 50, kind: 'bull' };
  if (r < RING.bullOut) return { pts: 25, kind: 'bull' };
  let a = Math.atan2(x, y); // 上が0、時計回り
  a = ((a + Math.PI / 20) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const base = SECTORS[Math.floor(a / (Math.PI / 10)) % 20];
  if (r >= RING.triIn && r < RING.triOut) return { pts: base * 3, kind: 'triple' };
  if (r >= RING.dblIn) return { pts: base * 2, kind: 'double' };
  return { pts: base, kind: 'single' };
}

// ---------- コース ----------
const course = new THREE.Group();
scene.add(course);
let gates = [], obstacles = [], boardZ = -300, approachZ = -260, target = 0;

const stripeTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ff3b4e'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffd23d';
  for (let i = -128; i < 256; i += 40) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 20, 0); g.lineTo(i + 20 - 128, 128); g.lineTo(i - 128, 128); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const obstacleMat = new THREE.MeshStandardMaterial({ map: stripeTex, emissive: 0x551018, roughness: 0.5 });
obstacleMat.userData.keep = true;
const ojamaMat = new THREE.MeshStandardMaterial({ map: stripeTex, color: 0xc58cff, emissive: 0x3a0a66, roughness: 0.5 });
ojamaMat.userData.keep = true;
const postMat = new THREE.MeshStandardMaterial({ color: 0x5a66b8, metalness: 0.6, roughness: 0.3, emissive: 0x1a2266 });
postMat.userData.keep = true;
const railMat = new THREE.MeshBasicMaterial({ color: 0x3fd8ff });
railMat.userData.keep = true;
const trackTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1c2258'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#2d3a8a'; g.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  g.fillStyle = '#3fd8ff';
  g.fillRect(124, 20, 8, 90); g.fillRect(124, 148, 8, 90);   // 中央の点線（左右ゲートの境目）
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
})();
const trackMat = new THREE.MeshStandardMaterial({ map: trackTex, roughness: 0.65, metalness: 0.15 });
trackMat.userData.keep = true;
const curbMat = new THREE.MeshStandardMaterial({ color: 0x2a3170, roughness: 0.5, metalness: 0.3 });
curbMat.userData.keep = true;
const pillarMat = new THREE.MeshStandardMaterial({ color: 0x343d86, roughness: 0.4, metalness: 0.5, emissive: 0x0d1033 });
pillarMat.userData.keep = true;
const capMat = new THREE.MeshBasicMaterial({ color: 0xff3d7f });
capMat.userData.keep = true;
const gateEdgeGood = new THREE.MeshStandardMaterial({ color: 0x2f8dff, transparent: true, opacity: 0.85, emissive: 0x0a3a8a });
const gateEdgeBad = new THREE.MeshStandardMaterial({ color: 0xff3d55, transparent: true, opacity: 0.85, emissive: 0x7a0a1e });

function isGood(op) { return op.t === '+' || op.t === '×'; }
function makeOp(s, good) {
  const k = 1 + (s - 1) * 0.6;
  if (good) {
    if (rng() < 0.45) return { t: '+', v: Math.round(cri(4, 20) * k) };
    return { t: '×', v: cri(2, Math.min(2 + Math.ceil(s * 0.9), 9)) };
  }
  if (rng() < 0.55) return { t: '-', v: Math.round(cri(5, 25) * k) };
  return { t: '÷', v: cri(2, 3) };
}
function applyOp(op, c) {
  let r;
  switch (op.t) {
    case '+': r = c + op.v; break;
    case '-': r = c - op.v; break;
    case '×': r = c * op.v; break;
    default: r = Math.floor(c / op.v);
  }
  return clamp(r, 0, 1e18);
}

function gateTexture(op) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 212;
  const g = c.getContext('2d');
  const good = isGood(op);
  const grd = g.createLinearGradient(0, 0, 0, 212);
  grd.addColorStop(0, good ? 'rgba(80,185,255,0.9)' : 'rgba(255,80,100,0.9)');
  grd.addColorStop(1, good ? 'rgba(30,90,255,0.5)' : 'rgba(190,20,60,0.5)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 320);
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 202);
  const label = op.t + fmtJP(op.v);
  const fs = label.length <= 3 ? 112 : label.length <= 4 ? 90 : 70;
  g.font = `900 ${fs}px "M PLUS Rounded 1c", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 12;
  g.fillStyle = '#fff';
  g.fillText(label, 128, 112);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ゲートは 2×2（0:左上 1:右上 2:左下 3:右下）
const gateSlot = (i) => ({ x: (i % 2 ? 1 : -1) * 1.6, y: ROW_Y[i < 2 ? 0 : 1] });
function makeGate(z, ops) {
  const grp = new THREE.Group();
  grp.position.z = z;
  const planes = [];
  ops.forEach((op, i) => {
    const face = new THREE.MeshBasicMaterial({ map: gateTexture(op), transparent: true, depthWrite: false });
    const edge = (isGood(op) ? gateEdgeGood : gateEdgeBad).clone();
    const pl = new THREE.Mesh(new THREE.BoxGeometry(2.9, 2.4, 0.3), [edge, edge, edge, edge, face, face]);
    const p = gateSlot(i);
    pl.position.set(p.x, p.y, 0);
    grp.add(pl); planes.push(pl);
  });
  const H = 5.6;
  for (const x of [-LANE - 0.25, LANE + 0.25]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.42, H, 0.55), postMat);
    post.position.set(x, TRACK_Y + H / 2, 0);
    post.castShadow = true;
    grp.add(post);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(LANE * 2 + 1.0, 0.5, 0.7), postMat);
  top.position.set(0, TRACK_Y + H, 0);
  top.castShadow = true;
  grp.add(top);
  const topGlow = new THREE.Mesh(new THREE.BoxGeometry(LANE * 2 + 1.0, 0.1, 0.1), railMat);
  topGlow.position.set(0, TRACK_Y + H - 0.28, 0.36);
  grp.add(topGlow);
  // 上段と下段の境目の光るライン
  const mid = new THREE.Mesh(new THREE.BoxGeometry(LANE * 2 + 0.5, 0.08, 0.08), railMat);
  mid.position.set(0, SPLIT_Y, 0.2);
  grp.add(mid);
  course.add(grp);
  return { z, ops, grp, planes, used: false, fade: 0, pick: -1 };
}

function rollerGeometry() {
  const parts = [];
  const drum = new THREE.CylinderGeometry(1.0, 1.0, 1.6, 28);
  drum.rotateX(Math.PI / 2);
  parts.push(drum);
  for (let i = 0; i < 10; i++) {
    for (const zz of [-0.45, 0.45]) {
      const a = (i / 10) * Math.PI * 2 + (zz > 0 ? 0.31 : 0);
      const sp = new THREE.ConeGeometry(0.16, 0.5, 8);
      sp.rotateZ(a - Math.PI / 2);
      sp.translate(Math.cos(a) * 1.18, Math.sin(a) * 1.18, zz);
      parts.push(sp);
    }
  }
  return mergeGeometries(parts);
}

// 障害物: low=床を転がるローラー / high=空中のローラー / lift=上下に動く横バー
const OB_TYPES = ['low', 'high', 'lift'];
function makeObstacle(z, s, type, r = crand) {
  const o = { z, type, w: r(1.1, 1.7) + s * 0.08, ph: r(0, Math.PI * 2), done: false };
  if (type === 'lift') {
    const m = new THREE.Mesh(new THREE.BoxGeometry(LANE * 2 + 0.6, 0.7, 0.7), obstacleMat);
    m.castShadow = true;
    m.position.set(0, (Y_MIN + Y_MAX) / 2, z);
    course.add(m);
    for (const x of [-LANE - 0.6, LANE + 0.6]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 5.6, 0.25), postMat);
      rail.position.set(x, TRACK_Y + 2.8, z);
      course.add(rail);
    }
    Object.assign(o, { mesh: m, hw: LANE + 0.3, hh: 0.35, amp: (Y_MAX - Y_MIN) / 2 + 0.1, w: o.w * 0.9 });
  } else {
    const m = new THREE.Mesh(rollerGeometry(), obstacleMat);
    m.position.set(0, type === 'high' ? ROW_Y[0] + 0.1 : TRACK_Y + 1.25, z);
    m.castShadow = true;
    course.add(m);
    Object.assign(o, { mesh: m, hw: 1.2, hh: 1.2, amp: r(1.6, 2.4) });
  }
  return o;
}

function animObstacle(o, t) {
  const v = Math.sin(t * o.w + o.ph);
  if (o.type === 'lift') {
    o.mesh.position.y = (Y_MIN + Y_MAX) / 2 + v * o.amp;
  } else {
    o.mesh.position.x = v * o.amp;
    o.mesh.rotation.z = -o.mesh.position.x / 1.2;   // 転がる
  }
}

function clearCourse() {
  course.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.userData.keep) continue;
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
  course.clear();
}

function buildStage(s, seed = (Math.random() * 2 ** 31) | 0) {
  rng = mulberry32(seed);
  clearCourse();
  gates = []; obstacles = [];
  const nG = Math.min(6 + s, 16);
  let z = -30, best = 1;
  for (let i = 0; i < nG; i++) {
    const ops = [i === 0 ? { t: '+', v: cri(8, 14) } : makeOp(s, true)];
    const nBad = i === 0 ? 1 : cri(1, 2);
    for (let k = 0; k < 3; k++) ops.push(k < nBad ? makeOp(s, false) : i === 0 ? { t: '+', v: cri(2, 6) } : makeOp(s, true));
    for (let k = ops.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [ops[k], ops[j]] = [ops[j], ops[k]]; }
    gates.push(makeGate(z, ops));
    best = Math.max(...ops.map((op) => applyOp(op, best)));
    if (i > 0 && i < nG - 1 && rng() < Math.min(0.3 + s * 0.06, 0.7)) {
      const type = OB_TYPES[Math.floor(rng() * (s < 2 ? 2 : 3))];
      obstacles.push(makeObstacle(z - GATE_GAP / 2, s, type));
    }
    z -= GATE_GAP;
  }
  approachZ = z + 6;
  boardZ = approachZ - APPROACH_LEN;
  board.position.set(0, BOARD_Y, boardZ);
  // 空中に浮かぶコース（ボードの手前で途切れて、そこからダイブ）
  const startZ = 16, endZ = approachZ - 4;
  const len = startZ - endZ, midZ = (startZ + endZ) / 2;
  const W = LANE * 2 + 1.2;
  trackTex.repeat.set(1, len / 8);
  const track = new THREE.Mesh(new THREE.BoxGeometry(W, 1.0, len), trackMat);
  track.position.set(0, TRACK_Y - 0.5, midZ);
  track.receiveShadow = true;
  course.add(track);
  const under = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 1.6, len), curbMat);
  under.position.set(0, TRACK_Y - 1.6, midZ);
  course.add(under);
  for (const sx of [-1, 1]) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, len), curbMat);
    curb.position.set(sx * (W / 2 + 0.25), TRACK_Y + 0.0, midZ);
    curb.castShadow = curb.receiveShadow = true;
    course.add(curb);
    const neon = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, len), railMat);
    neon.position.set(sx * (W / 2 + 0.25), TRACK_Y + 0.4, midZ);
    course.add(neon);
    const neonLow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, len), railMat);
    neonLow.position.set(sx * (W / 2), TRACK_Y - 1.0, midZ);
    course.add(neonLow);
  }
  // コースの縁の柱（くぐり抜けるスピード感）
  const np = Math.floor(len / 14);
  const pillars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.4, 9, 12), pillarMat, np * 2);
  const caps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 14, 10), capMat, np * 2);
  const mm = new THREE.Matrix4();
  for (let i = 0; i < np; i++) {
    for (let k = 0; k < 2; k++) {
      const x = (k ? 1 : -1) * (W / 2 + 1.3), z = startZ - 7 - i * 14;
      mm.makeTranslation(x, TRACK_Y + 0.5, z); pillars.setMatrixAt(i * 2 + k, mm);
      mm.makeTranslation(x, TRACK_Y + 5.2, z); caps.setMatrixAt(i * 2 + k, mm);
    }
  }
  pillars.castShadow = true;
  course.add(pillars, caps);
  // 端っこの光るエッジ
  const lip = new THREE.Mesh(new THREE.BoxGeometry(W + 1, 0.2, 0.2), capMat);
  lip.position.set(0, TRACK_Y, endZ);
  course.add(lip);
  // 理想ルートの本数から目標スコアを決める（ちゃんと狙えば届く）
  target = niceFloor(best * 7);
}

// ---------- ゲーム状態 ----------
const S = {
  phase: 'home', stage: store.get('sd_stage', 1), count: 1,
  x: 0, y: 0.4, z: 0, tx: 0, ty: 0.4, prevX: 0, bank: 0,
  darts: [], debris: [], stuck: [], time: 0, timer: 0,
  score: 0, result: null, versus: false, startAt: 0,
};
let best = store.get('sd_best', 0);
let net = null;   // 対戦（net.js）

function swarmRadius() { return LAYOUT * Math.cbrt(Math.max(1, S.darts.length)); }

function syncVisible(withDebris = true) {
  const want = Math.min(MAXV, Math.max(0, Math.floor(S.count)));
  while (S.darts.length < want) {
    const i = S.darts.length;
    // 球の中に均等に詰める（立体的な群れ）
    const r = LAYOUT * Math.cbrt(i);
    const yy = 1 - 2 * ((i * 0.618034) % 1);
    const rr = Math.sqrt(1 - yy * yy), a = i * 2.39996;
    S.darts.push({ ox: 0, oy: 0, oz: 0, tx: Math.cos(a) * rr * r, ty: yy * r, tz: Math.sin(a) * rr * r * 1.3, ph: rand(0, 6.28) });
  }
  while (S.darts.length > want) {
    const d = S.darts.pop();
    if (withDebris) spawnDebris(S.x + d.ox, S.y + d.oy, S.z + d.oz);
  }
}

function spawnDebris(x, y, z) {
  if (S.debris.length >= MAXDEBRIS) S.debris.shift();
  S.debris.push({
    p: new THREE.Vector3(x, y, z),
    v: new THREE.Vector3(rand(-3, 3), rand(1, 5), rand(4, 10)),
    r: new THREE.Euler(rand(0, 6), rand(0, 6), 0),
    w: new THREE.Vector3(rand(-8, 8), rand(-8, 8), 0),
    life: 1.4,
  });
}

// ---------- DOM 演出 ----------
const fx = $('fx');
const tmpV = new THREE.Vector3();
function toScreen(x, y, z) {
  tmpV.set(x, y, z).project(camera);
  return { x: (tmpV.x * 0.5 + 0.5) * window.innerWidth, y: (-tmpV.y * 0.5 + 0.5) * window.innerHeight };
}
function popup(text, cls, sx, sy) {
  const el = document.createElement('div');
  el.className = 'pop ' + cls;
  el.textContent = text;
  el.style.left = sx + 'px';
  el.style.top = sy + 'px';
  fx.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}
function popAtSwarm(text, cls) {
  const p = toScreen(S.x, S.y + swarmRadius() + 0.4, S.z);
  popup(text, cls, p.x, p.y - 40);
}
const flashEl = $('flash');
function flash(color) {
  flashEl.style.background = color;
  flashEl.classList.remove('on');
  void flashEl.offsetWidth;
  flashEl.classList.add('on');
}

function show(id, on) { $(id).classList.toggle('hidden', !on); }

function updateHomeInfo() {
  $('homeStage').textContent = S.stage;
  $('homeBest').textContent = fmtJP(best);
  show('btnReset', S.stage > 1);
  $('btnSound').textContent = muted ? '🔇' : '🔊';
}

// ---------- 進行 ----------
function goHome() {
  S.phase = 'home';
  buildStage(S.stage);
  S.count = 48; S.darts = []; S.debris = []; S.stuck = [];
  S.x = S.tx = 0; S.y = S.ty = 0.6; S.z = 0;
  syncVisible(false);
  show('home', true); show('hud', false); show('result', false);
  updateHomeInfo();
}

function resetRun(level, seed) {
  audio();
  buildStage(level, seed);
  S.count = 1; S.darts = []; S.debris = []; S.stuck = []; S.result = null; S.score = 0;
  S.x = S.tx = 0; S.y = S.ty = ROW_Y[1]; S.z = 0; S.prevX = 0; S.bank = 0;
  syncVisible(false);
  show('home', false); show('result', false); show('hud', true); show('aimHint', false);
  camera.position.set(0, 3.4, 9);
}

function startStage() {
  S.versus = false;
  resetRun(S.stage);
  S.phase = 'run';
  $('hudStage').textContent = 'STAGE ' + S.stage;
  $('hudTarget').textContent = '目標 ' + fmtJP(target);
}

// 対戦スタート（全員同じシードで同じコース、startAt にいっせいにスタート）
let cdShown = -1;
function startVersus(o) {
  S.versus = true;
  S.now = o.now;
  S.startAt = o.startAt;
  S.vsLevel = o.level;
  resetRun(o.level, o.seed);
  S.phase = 'count';
  cdShown = -1;
  $('hudStage').textContent = '⚔ 対戦';
  $('hudTarget').textContent = o.levelName;
}

function exitVersus() {
  S.versus = false;
  setGhosts([]);
  show('countdown', false);
}

function setGhosts(list) {
  ghosts = list;
  const ids = new Set(list.map((g) => g.id));
  for (const id of [...ghostState.keys()]) {
    if (!ids.has(id)) { const st = ghostState.get(id); if (st.el) st.el.remove(); ghostState.delete(id); }
  }
}

function ojama(name, color) {
  if (!S.versus || S.phase !== 'run') return;
  const z = S.z - 36;
  if (z < approachZ + 6) return;
  const o = makeObstacle(z, S.vsLevel || 4, OB_TYPES[Math.floor(Math.random() * 3)], rand);
  o.mesh.material = ojamaMat;
  obstacles.push(o);
  sfx.bad();
  const el = document.createElement('div');
  el.className = 'stampPop';
  el.style.color = color;
  el.innerHTML = '💥 <span></span>';
  el.querySelector('span').textContent = `${name} からおじゃま！`;
  $('stampLayer').appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function stamp(name, s, color) {
  const el = document.createElement('div');
  el.className = 'stampPop';
  el.style.color = color;
  el.textContent = name;
  const sp = document.createElement('span');
  sp.textContent = s;
  el.appendChild(sp);
  const layer = $('stampLayer');
  layer.appendChild(el);
  while (layer.children.length > 4) layer.firstChild.remove();
  setTimeout(() => el.remove(), 2400);
  tone(880, 0.08, 'triangle', 0.08);
}

function changeCount(next, label, good) {
  const before = S.count;
  S.count = next;
  syncVisible(true);
  popAtSwarm(label, good ? 'good' : 'bad');
  if (good) { sfx.good(); flash('rgba(63,169,255,0.6)'); }
  else { sfx.bad(); flash('rgba(255,60,80,0.6)'); }
  if (S.count <= 0 && before > 0) die();
}

function die() {
  S.phase = 'dead';
  S.timer = 0;
  sfx.lose();
  popup('全滅…', 'bad huge', window.innerWidth / 2, window.innerHeight * 0.45);
}

function doHit() {
  S.phase = 'hit';
  S.timer = 0;
  let sum = 0, bulls = 0;
  const tally = { bull: 0, triple: 0, double: 0, single: 0, miss: 0 };
  for (const d of S.darts) {
    const wx = S.x + d.ox, wy = S.y + d.oy;
    const res = scoreAt(wx, wy - BOARD_Y);
    sum += res.pts;
    tally[res.kind]++;
    if (res.kind === 'bull') bulls++;
    if (res.kind === 'miss') spawnDebris(wx, wy, boardZ + 0.6);
    else S.stuck.push({ x: wx, y: wy, z: boardZ + 0.36 + Math.random() * 0.12, rx: rand(-0.08, 0.08), ry: rand(-0.08, 0.08), rz: rand(0, 6.28) });
  }
  const n = Math.max(1, S.darts.length);
  const avg = sum / n;
  S.score = Math.round(avg * S.count);
  S.result = { avg, bullRate: bulls / n, tally, count: S.count };
  S.darts = [];
  sfx.thud();
  flash('rgba(255,255,255,0.8)');
  shake = 0.8;
  burst(S.x, S.y, boardZ + 0.8, 0xffd23d, 90, 12);
  burst(S.x, S.y, boardZ + 0.8, 0xff3d7f, 60, 10);
  const c = toScreen(0, BOARD_Y, boardZ);
  const tag = tally.bull / n > 0.4 ? 'BULL!!' : tally.triple / n > 0.3 ? 'TRIPLE!!' : tally.miss / n > 0.6 ? 'うーん…' : 'ドスッ!!';
  popup(tag, 'gold', c.x, c.y);
  setTimeout(() => popup(fmtJP(S.score) + '点', 'huge', window.innerWidth / 2, window.innerHeight * 0.4), 450);
}

function showResult() {
  S.phase = 'result';
  show('hud', false);
  const dead = !S.result;
  if (S.versus && net) {
    net.finish({ score: dead ? 0 : S.score, count: dead ? 0 : S.result.count, avg: dead ? 0 : Math.round(S.result.avg * 10) / 10 });
    return;
  }
  const clear = !dead && S.score >= target;
  if (!dead && S.score > best) { best = S.score; store.set('sd_best', best); }
  const t = $('resTitle');
  t.textContent = dead ? '全滅…' : clear ? `STAGE ${S.stage} CLEAR!` : 'おしい！目標未達';
  t.className = clear ? 'clear' : 'fail';
  $('resTarget').textContent = '目標 ' + fmtJP(target) + '点';
  $('resCount').textContent = dead ? '0' : fmtJP(S.result.count);
  $('resAvg').textContent = dead ? '0' : S.result.avg.toFixed(1);
  $('resBull').textContent = dead ? '0%' : Math.round(S.result.bullRate * 100) + '%';
  show('resBadge', !dead && S.score >= 1e10);
  $('btnNext').textContent = clear ? '次のステージへ' : 'リトライ';
  $('btnNext').dataset.clear = clear ? '1' : '';
  show('result', true);
  const final = dead ? 0 : S.score;
  const t0 = performance.now();
  const el = $('resScore');
  (function count() {
    const k = Math.min(1, (performance.now() - t0) / 1100);
    el.textContent = fmtJP(final * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(count);
  })();
  if (clear) sfx.win(); else if (!dead) sfx.lose();
}

// ---------- 入力 ----------
let dragging = false, lx = 0, ly = 0;
const keys = new Set();
window.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const k = 9 / Math.min(window.innerWidth, 700);
  if (S.phase === 'run' || S.phase === 'approach' || S.phase === 'count') {
    S.tx += (e.clientX - lx) * k;
    S.ty -= (e.clientY - ly) * k;
  }
  lx = e.clientX; ly = e.clientY;
});
const endDrag = () => { dragging = false; };
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('keydown', (e) => keys.add(e.key));
window.addEventListener('keyup', (e) => keys.delete(e.key));

$('btnStart').addEventListener('click', startStage);
$('btnReset').addEventListener('click', () => { S.stage = 1; store.set('sd_stage', 1); goHome(); });
$('btnSound').addEventListener('click', () => { muted = !muted; store.set('sd_muted', muted); audio(); updateHomeInfo(); });
$('btnNext').addEventListener('click', () => {
  if ($('btnNext').dataset.clear) { S.stage++; store.set('sd_stage', S.stage); }
  startStage();
});
$('btnHome').addEventListener('click', goHome);
$('btnShare').addEventListener('click', () => {
  const text = `SWARM DARTS ステージ${S.stage}で ${fmtJP(S.score)}点！ #中濱Games`;
  const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(location.href);
  window.open(url, '_blank', 'noopener');
});

// ---------- メインループ ----------
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eul = new THREE.Euler(), pv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), sv = new THREE.Vector3();
const camTarget = new THREE.Vector3(), lookAt = new THREE.Vector3(), lookCur = new THREE.Vector3(0, 0, -10);
const countTag = $('countTag');
const clock = new THREE.Clock();

function update(dt) {
  S.time += dt;
  const t = S.time;

  // キーボード操作
  let kx = 0, ky = 0;
  if (keys.has('ArrowLeft') || keys.has('a')) kx -= 1;
  if (keys.has('ArrowRight') || keys.has('d')) kx += 1;
  if (keys.has('ArrowUp') || keys.has('w')) ky += 1;
  if (keys.has('ArrowDown') || keys.has('s')) ky -= 1;

  if (S.phase === 'count') {
    S.tx = clamp(S.tx + kx * 8 * dt, -LANE + 0.4, LANE - 0.4);
    S.ty = clamp(S.ty + ky * 8 * dt, Y_MIN, Y_MAX);
    const remain = (S.startAt - S.now()) / 1000;
    const n = Math.ceil(remain);
    if (remain <= 0) {
      S.phase = 'run';
      show('countdown', false);
      popup('GO!', 'huge', window.innerWidth / 2, window.innerHeight * 0.38);
      tone(1046, 0.3, 'triangle', 0.14);
    } else if (n !== cdShown && n <= 3) {
      cdShown = n;
      const cd = $('countdown');
      cd.textContent = n;
      show('countdown', true);
      cd.classList.remove('tick'); void cd.offsetWidth; cd.classList.add('tick');
      tone(523, 0.15, 'triangle', 0.12);
    }
  }

  if (S.phase === 'run' || S.phase === 'approach') {
    S.tx += kx * 8 * dt;
    S.ty += ky * 8 * dt;

    const prevZ = S.z;
    const speed = S.phase === 'run' ? RUN_SPEED : APPROACH_SPEED;
    S.z -= speed * dt;

    if (S.phase === 'run') {
      S.tx = clamp(S.tx, -LANE + 0.4, LANE - 0.4);
      S.ty = clamp(S.ty, Y_MIN, Y_MAX);
      // ゲート判定（上下左右の4択）
      for (const g of gates) {
        if (!g.used && prevZ > g.z && S.z <= g.z) {
          g.used = true;
          const idx = (S.y < SPLIT_Y ? 2 : 0) + (S.x < 0 ? 0 : 1);
          const op = g.ops[idx];
          g.pick = idx;
          const sp = gateSlot(idx);
          burst(sp.x, sp.y, g.z, isGood(op) ? 0x6cc6ff : 0xff4b5c, 46, 9, 12);
          if (isGood(op)) fovKick = 9;
          if (S.versus && net) net.onGate(op);
          const next = applyOp(op, S.count);
          changeCount(next, op.t + fmtJP(op.v), isGood(op));
        }
      }
      // 障害物判定
      for (const o of obstacles) {
        if (!o.done && prevZ > o.z && S.z <= o.z) {
          o.done = true;
          const rad = swarmRadius() * 0.8;
          const ox = o.hw + rad - Math.abs(S.x - o.mesh.position.x);
          const oy = o.hh + rad - Math.abs(S.y - o.mesh.position.y);
          const overlap = Math.min(ox, oy);
          if (ox > 0 && oy > 0 && S.count > 0) {
            const frac = Math.min(1, overlap / (2 * rad + 0.2)) * 0.7;
            const loss = Math.max(1, Math.ceil(S.count * frac));
            sfx.hitObstacle();
            shake = 0.5;
            burst(S.x, S.y, S.z, 0xffd23d, 30, 7, 10);
            changeCount(S.count - loss, '-' + fmtJP(loss), false);
          }
        }
      }
      if (S.phase === 'run' && S.z <= approachZ) {
        S.phase = 'approach';
        show('aimHint', true);
      }
    } else {
      S.tx = clamp(S.tx, -BOARD_R, BOARD_R);
      S.ty = clamp(S.ty, BOARD_Y - BOARD_R, BOARD_Y + BOARD_R);
      if (S.z - 0.5 <= boardZ) { show('aimHint', false); doHit(); }
    }
  }

  // 群れの移動
  S.x += (S.tx - S.x) * damp(14, dt);
  S.y += (S.ty - S.y) * damp(10, dt);
  const vx = (S.x - S.prevX) / Math.max(dt, 1e-4);
  S.prevX = S.x;
  S.bank += (clamp(-vx * 0.05, -0.6, 0.6) - S.bank) * damp(8, dt);

  // ゲート・障害物のアニメ
  for (const g of gates) {
    if (g.used && g.fade < 1) {
      g.fade = Math.min(1, g.fade + dt * 2.5);
      g.planes.forEach((p, i) => {
        p.material.forEach((m) => { m.opacity = (m.map ? 1 : 0.85) * (1 - g.fade); });
        if (i === g.pick) p.scale.setScalar(1 + g.fade * 0.4);
      });
    }
  }
  for (const o of obstacles) animObstacle(o, t);

  if (S.phase === 'home') {
    S.z = 0; S.tx = Math.sin(t * 0.7) * 1.2; S.ty = 0.9 + Math.sin(t * 1.1) * 0.3;
  }

  // ダーツのインスタンス更新
  let n = 0;
  const kOff = damp(8, dt);
  for (const d of S.darts) {
    d.ox += (d.tx - d.ox) * kOff;
    d.oy += (d.ty - d.oy) * kOff;
    d.oz += (d.tz - d.oz) * kOff;
    pv.set(S.x + d.ox, S.y + d.oy + Math.sin(t * 6 + d.ph) * 0.04, S.z + d.oz);
    eul.set(Math.sin(t * 3 + d.ph) * 0.04, Math.cos(t * 3 + d.ph) * 0.04, S.bank + t * 3 + d.ph);
    q.setFromEuler(eul);
    m4.compose(pv, q, one);
    dartMesh.setMatrixAt(n++, m4);
  }
  for (const s of S.stuck) {
    pv.set(s.x, s.y, s.z);
    eul.set(s.rx, s.ry, s.rz);
    q.setFromEuler(eul);
    m4.compose(pv, q, one);
    dartMesh.setMatrixAt(n++, m4);
    if (n >= MAXV) break;
  }
  for (let i = S.debris.length - 1; i >= 0; i--) {
    const b = S.debris[i];
    b.life -= dt;
    if (b.life <= 0) { S.debris.splice(i, 1); continue; }
  }
  for (const b of S.debris) {
    b.v.y -= 18 * dt;
    b.p.addScaledVector(b.v, dt);
    b.r.x += b.w.x * dt; b.r.y += b.w.y * dt;
    q.setFromEuler(b.r);
    m4.compose(b.p, q, one);
    dartMesh.setMatrixAt(n++, m4);
  }
  dartMesh.count = n;
  dartMesh.instanceMatrix.needsUpdate = true;

  // ゴースト（対戦相手）
  let gn = 0;
  const showG = S.versus && (S.phase === 'count' || S.phase === 'run' || S.phase === 'approach');
  if (showG) {
    const nowMs = S.now();
    for (const g of ghosts) {
      let gz = g.z;
      if (g.ph === 'run' || g.ph === 'approach') {
        const sp = g.ph === 'run' ? RUN_SPEED : APPROACH_SPEED;
        gz = Math.max(boardZ + 1, g.z - sp * clamp((nowMs - g.t) / 1000, 0, 1.5));
      }
      let st = ghostState.get(g.id);
      if (!st) {
        st = { x: g.x, y: g.y, z: gz, el: document.createElement('div') };
        st.el.className = 'gtag';
        $('ghostTags').appendChild(st.el);
        ghostState.set(g.id, st);
      }
      st.x += (g.x - st.x) * damp(8, dt);
      st.y += (g.y - st.y) * damp(8, dt);
      st.z += (gz - st.z) * damp(10, dt);
      const rad = LAYOUT * Math.cbrt(Math.min(MAXV, Math.max(1, g.c)));
      const vis = Math.min(GPER, Math.max(1, Math.round(Math.cbrt(g.c) * 4)));
      const col = new THREE.Color(g.color);
      for (let i = 0; i < vis && gn < GMAX; i++) {
        const b = GBALL[i];
        pv.set(st.x + b.x * rad, st.y + b.y * rad, st.z + b.z * rad);
        eul.set(0, 0, t * 3 + i);
        q.setFromEuler(eul);
        m4.compose(pv, q, one);
        ghostMesh.setMatrixAt(gn, m4);
        ghostMesh.setColorAt(gn, col);
        gn++;
      }
      const sp = toScreen(st.x, st.y + rad + 0.35, st.z);
      const behind = tmpV.z > 1;
      st.el.style.display = behind ? 'none' : '';
      st.el.style.color = g.color;
      st.el.style.transform = `translate(${sp.x}px, ${sp.y}px) translate(-50%, -100%)`;
      st.el.innerHTML = '';
      st.el.append(g.name);
      const bb = document.createElement('b');
      bb.textContent = fmtJP(g.c);
      st.el.appendChild(bb);
    }
  }
  $('ghostTags').style.display = showG ? '' : 'none';
  ghostMesh.count = gn;
  ghostMesh.instanceMatrix.needsUpdate = true;
  if (ghostMesh.instanceColor) ghostMesh.instanceColor.needsUpdate = true;

  // カメラ
  if (S.phase === 'home') {
    const a = t * 0.25;
    camTarget.set(Math.sin(a) * 7, 1.6 + Math.sin(t * 0.4) * 0.4, Math.cos(a) * 7);
    lookAt.set(0, 3.4, 0);
  } else if (S.phase === 'run' || S.phase === 'count' || S.phase === 'dead' || (S.phase === 'result' && !S.result)) {
    camTarget.set(S.x * 0.5, 2.0 + S.y * 0.5, S.z + 7.8);
    lookAt.set(S.x * 0.65, 0.5 + S.y * 0.6, S.z - 10);
  } else if (S.phase === 'approach') {
    camTarget.set(S.x * 0.6, S.y + 1.2, S.z + 8);
    lookAt.set(S.x * 0.6, S.y * 0.8 + BOARD_Y * 0.2, S.z - 20);
  } else {
    // 斜めから回り込んで、刺さったダーツの立体感を見せる
    const a = Math.min(1, S.timer * 0.5) * 0.55 + 0.2;
    camTarget.set(Math.sin(a) * 17, BOARD_Y + 3.2, boardZ + Math.cos(a) * 17);
    lookAt.set(0, BOARD_Y, boardZ);
  }
  camera.position.lerp(camTarget, damp(S.phase === 'home' ? 2 : 6, dt));
  lookCur.lerp(lookAt, damp(8, dt));
  camera.lookAt(lookCur);
  camera.rotateZ(S.bank * 0.3);   // 曲がるときに傾く
  if (shake > 0) {
    camera.position.x += rand(-1, 1) * shake * 0.25;
    camera.position.y += rand(-1, 1) * shake * 0.25;
    shake = Math.max(0, shake - dt * 2.5);
  }
  fovKick += (0 - fovKick) * damp(3, dt);
  const speedFov = S.phase === 'run' ? 4 : 0;
  camera.fov = baseFov + fovKick + speedFov;
  camera.updateProjectionMatrix();

  // 影を落とすライトを群れに追従
  const fx0 = S.phase === 'hit' || S.phase === 'result' ? 0 : S.x;
  const fz0 = S.phase === 'hit' || S.phase === 'result' ? boardZ : S.z;
  sun.position.set(fx0 + 5, 12, fz0 + 6);
  sun.target.position.set(fx0, 0, fz0);

  // 浮遊ブロック
  for (let i = 0; i < FB; i++) {
    const f = floatData[i];
    if (f.z > camera.position.z + 12) resetFloater(f, camera.position.z - 40);
    f.ry += f.w * dt;
    eul.set(f.rx, f.ry, 0); q.setFromEuler(eul);
    pv.set(f.x, f.y, f.z); sv.set(f.s, f.sy, f.s);
    m4.compose(pv, q, sv);
    floaters.setMatrixAt(i, m4);
  }
  floaters.instanceMatrix.needsUpdate = true;

  // パーティクル
  let bn = 0;
  for (let i = bursts.length - 1; i >= 0; i--) { bursts[i].life -= dt; if (bursts[i].life <= 0) bursts.splice(i, 1); }
  for (const b of bursts) {
    b.v.y -= 9 * dt;
    b.p.addScaledVector(b.v, dt);
    b.r += dt * 6;
    eul.set(b.r, b.r * 0.7, 0); q.setFromEuler(eul);
    const k = Math.min(1, b.life * 2);
    sv.set(k, k, k);
    m4.compose(b.p, q, sv);
    burstMesh.setMatrixAt(bn, m4);
    burstMesh.setColorAt(bn, b.c);
    bn++;
  }
  burstMesh.count = bn;
  burstMesh.instanceMatrix.needsUpdate = true;
  if (burstMesh.instanceColor) burstMesh.instanceColor.needsUpdate = true;

  // ボードのゆれ
  if (S.phase === 'hit') {
    const s = Math.max(0, 0.4 - S.timer) * 0.6;
    board.position.x = Math.sin(t * 60) * s;
  } else board.position.x = 0;

  // 背景
  stars.position.copy(camera.position);
  grid.position.z = Math.round(camera.position.z / 2.5) * 2.5;
  const moving = S.phase === 'run' || S.phase === 'approach';
  speedLines.visible = moving;
  if (moving) {
    for (let i = 0; i < LN; i++) {
      const l = lineData[i];
      if (l.z > camera.position.z + 2) resetLine(l, camera.position.z - 30);
      linePos.set([l.x, l.y, l.z, l.x, l.y, l.z + l.len], i * 6);
    }
    lineGeo.attributes.position.needsUpdate = true;
  }

  // HUD
  if (moving || S.phase === 'count') {
    const p = toScreen(S.x, S.y + swarmRadius() + 0.35, S.z);
    countTag.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    countTag.textContent = fmtJP(S.count);
    countTag.style.display = '';
    $('hudBar').style.width = Math.min(100, (-S.z / -boardZ) * 100) + '%';
  } else {
    countTag.style.display = 'none';
  }

  // タイマー系の遷移
  if (S.phase === 'hit' || S.phase === 'dead') {
    S.timer += dt;
    if (S.phase === 'dead') S.z -= RUN_SPEED * 0.3 * dt;
    if (S.timer > (S.phase === 'hit' ? 2.2 : 1.4)) {
      if (S.phase === 'dead') { S.result = null; S.score = 0; }
      showResult();
    }
  }
}

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// ---------- 対戦（net.js）とのつなぎ ----------
net = initNet({
  startVersus,
  exitVersus,
  setGhosts,
  ojama,
  stamp,
  live() {
    if (!S.versus || !(S.phase === 'count' || S.phase === 'run' || S.phase === 'approach')) return null;
    return { x: Math.round(S.x * 100) / 100, y: Math.round(S.y * 100) / 100, z: Math.round(S.z * 10) / 10, c: S.count, ph: S.phase };
  },
  showHome(on) { show('home', on); if (!on) show('result', false); },
  toHome() { exitVersus(); goHome(); },
  notice(text) { popup(text, 'good', window.innerWidth / 2, window.innerHeight * 0.3); },
  fmt: fmtJP,
  sfx,
});

// テスト用フック（?debug のときだけ）
if (location.search.includes('debug')) window.__sd = { S, get gates() { return gates; }, get obstacles() { return obstacles; }, applyOp, gateSlot };

// フォント読み込み後にテクスチャを作る
(async () => {
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]); } catch { /* 無視 */ }
  buildBoard();
  goHome();
  $('loading').remove();
  loop();
})();
