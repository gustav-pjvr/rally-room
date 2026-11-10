/**
 * Host screen renderer: a sun-bleached hard court at dusk, drawn with flat
 * and toon shading, everything generated in code. Reads MatchView only and
 * never changes game state. render() allocates nothing per frame.
 */
import * as THREE from 'three';
import { COURT, type MatchView, type PlayerView } from '../../engine/types';

export interface Renderer {
  render(view: MatchView, now: number): void;
  resize(): void;
  dispose(): void;
}

const PALETTE = {
  clay: 0xd9622b,
  field: 0x4a4a36,
  cream: 0xf3e9d2,
  teal: 0x0f4c5c,
  tealCourt: 0x1d6573,
  ink: 0x1b1b1e,
  ball: 0xd8ef3a,
  skyTop: 0x24525e,
  skyMid: 0x9a9f8c,
  skyHorizon: 0xf4c58e,
  sun: 0xf8e2ae,
  hillFar: 0xc98b66,
  hillNear: 0x7a5546,
  skyline: 0x3d3a40,
  lampOff: 0x6b5a48,
  lampOn: 0xfff0c4,
} as const;

const MAX_FIGURES = 4;
const TRAIL = 10;
const SWING_MS = 320;
const RECOVER_MS = 320;

interface Figure {
  root: THREE.Group;
  bodyMat: THREE.MeshToonMaterial;
  pivot: THREE.Group;
  ring: THREE.Mesh;
  color: string;
  yaw: number;
  armYaw: number;
  armPitch: number;
  lastSwing: number | null;
  swingKind: PlayerView['stance'];
  prevX: number;
  prevZ: number;
  speed: number;
}

function toonGradient(): THREE.DataTexture {
  const data = new Uint8Array([70, 150, 255]);
  const texture = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) draw(g, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(PALETTE.skyHorizon, 70, 260);
  const camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.1, 600);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const geo = <T extends THREE.BufferGeometry>(g: T): T => { geometries.push(g); return g; };
  const mat = <T extends THREE.Material>(m: T): T => { materials.push(m); return m; };
  const tex = <T extends THREE.Texture>(t: T): T => { textures.push(t); return t; };
  const gradient = tex(toonGradient());

  // ---- Light: one low sun from the far left, long shadows toward the camera.
  const hemi = new THREE.HemisphereLight(0xbfd6d2, PALETTE.clay, 1.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd3a1, 3.2);
  sun.position.set(-34, 13, -30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24; sc.near = 1; sc.far = 110;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  // ---- Sky dome with vertex colours (horizon glow to deep teal).
  {
    const sky = geo(new THREE.SphereGeometry(320, 32, 16));
    const pos = sky.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PALETTE.skyTop);
    const mid = new THREE.Color(PALETTE.skyMid);
    const hor = new THREE.Color(PALETTE.skyHorizon);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) / 320;
      if (h < 0.08) c.copy(hor);
      else if (h < 0.3) c.lerpColors(hor, mid, (h - 0.08) / 0.22);
      else c.lerpColors(mid, top, Math.min(1, (h - 0.3) / 0.45));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    sky.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const dome = new THREE.Mesh(sky, mat(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    dome.renderOrder = -10;
    scene.add(dome);
  }

  // ---- Distant scenery: low sun, two hill layers, a small skyline, poplars.
  {
    const sunDisc = new THREE.Mesh(geo(new THREE.CircleGeometry(26, 48)), mat(new THREE.MeshBasicMaterial({ color: PALETTE.sun, fog: false })));
    sunDisc.position.set(-70, 14, -290);
    scene.add(sunDisc);

    const hill = (color: number, z: number, height: number, seed: number) => {
      const shape = new THREE.Shape();
      const w = 520;
      shape.moveTo(-w / 2, -20);
      for (let i = 0; i <= 40; i++) {
        const x = -w / 2 + (w * i) / 40;
        const y = height * (0.55 + 0.3 * Math.sin(i * 0.37 + seed) + 0.15 * Math.sin(i * 1.13 + seed * 2));
        shape.lineTo(x, y);
      }
      shape.lineTo(w / 2, -20);
      const mesh = new THREE.Mesh(geo(new THREE.ShapeGeometry(shape)), mat(new THREE.MeshBasicMaterial({ color, fog: false })));
      mesh.position.set(0, 0, z);
      scene.add(mesh);
    };
    hill(PALETTE.hillFar, -250, 26, 1.2);
    hill(PALETTE.hillNear, -170, 13, 4.1);

    const skylineMat = mat(new THREE.MeshBasicMaterial({ color: PALETTE.skyline, fog: false }));
    const box = geo(new THREE.PlaneGeometry(1, 1));
    const blocks: [number, number, number][] = [[38, 9, 7], [46, 14, 6], [53, 7, 9], [61, 18, 5], [67, 10, 8], [75, 12, 6], [-96, 8, 9], [-87, 12, 5]];
    for (const [x, h, w] of blocks) {
      const m = new THREE.Mesh(box, skylineMat);
      m.scale.set(w, h, 1);
      m.position.set(x, h / 2 + 2, -150);
      scene.add(m);
    }
    const treeMat = mat(new THREE.MeshBasicMaterial({ color: 0x2c3b36, fog: false }));
    const tree = geo(new THREE.CircleGeometry(1, 20));
    for (let i = 0; i < 9; i++) {
      const t = new THREE.Mesh(tree, treeMat);
      const x = -60 + i * 13 + (i % 3) * 4;
      if (x > -12 && x < 14) continue;
      t.scale.set(2.2, 6 + (i % 4) * 1.5, 1);
      t.position.set(x, 5 + (i % 4), -60);
      scene.add(t);
    }
  }

  // ---- Ground: flat poster colours plus a shadow catcher on top.
  const flat = (color: number) => mat(new THREE.MeshBasicMaterial({ color }));
  const plane = geo(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const addFlat = (m: THREE.Material, x: number, z: number, w: number, d: number, y: number) => {
    const mesh = new THREE.Mesh(plane, m);
    mesh.scale.set(w, 1, d);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    return mesh;
  };
  addFlat(flat(PALETTE.field), 0, 0, 600, 600, -0.02);
  addFlat(flat(PALETTE.clay), 0, 0, 2 * (COURT.doublesHalfWidth + 4.2), 2 * (COURT.halfLength + 6.6), -0.01);
  addFlat(flat(PALETTE.tealCourt), 0, 0, 2 * COURT.doublesHalfWidth, 2 * COURT.halfLength, 0);
  const shadowCatcher = addFlat(mat(new THREE.ShadowMaterial({ color: PALETTE.ink, opacity: 0.38 })), 0, 0, 60, 60, 0.004);
  shadowCatcher.receiveShadow = true;

  // Lines: cream, real layout. Baselines 10 cm, others 6 cm.
  {
    const lineMat = flat(PALETTE.cream);
    const y = 0.002;
    const L = COURT.halfLength;
    const S = COURT.singlesHalfWidth;
    const D = COURT.doublesHalfWidth;
    const v = (x: number, z0: number, z1: number) => addFlat(lineMat, x, (z0 + z1) / 2, 0.06, Math.abs(z1 - z0), y);
    const h = (z: number, x0: number, x1: number, w = 0.06) => addFlat(lineMat, (x0 + x1) / 2, z, Math.abs(x1 - x0), w, y);
    h(L - 0.05, -D, D, 0.1); h(-L + 0.05, -D, D, 0.1);
    v(-D + 0.03, -L, L); v(D - 0.03, -L, L);
    v(-S + 0.03, -L, L); v(S - 0.03, -L, L);
    h(COURT.serviceLine, -S, S); h(-COURT.serviceLine, -S, S);
    v(0, -COURT.serviceLine, COURT.serviceLine);
    v(0, L - 0.2, L); v(0, -L, -L + 0.2);
  }

  // ---- Net: posts, mesh texture, cream band.
  {
    const netHalf = COURT.doublesHalfWidth + 0.914;
    const netTex = tex(canvasTexture(64, (g, s) => {
      g.clearRect(0, 0, s, s);
      g.strokeStyle = 'rgba(27,27,30,0.9)';
      g.lineWidth = 6;
      g.strokeRect(0, 0, s, s);
    }));
    netTex.wrapS = THREE.RepeatWrapping;
    netTex.wrapT = THREE.RepeatWrapping;
    netTex.repeat.set((netHalf * 2) / 0.12, COURT.netHeight / 0.12);
    const net = new THREE.Mesh(geo(new THREE.PlaneGeometry(netHalf * 2, COURT.netHeight)),
      mat(new THREE.MeshBasicMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })));
    net.position.set(0, COURT.netHeight / 2, 0);
    scene.add(net);
    const band = new THREE.Mesh(geo(new THREE.BoxGeometry(netHalf * 2, 0.07, 0.03)), flat(PALETTE.cream));
    band.position.set(0, COURT.netHeight - 0.035, 0);
    scene.add(band);
    const postGeo = geo(new THREE.CylinderGeometry(0.05, 0.05, 1.07, 10));
    const postMat = mat(new THREE.MeshToonMaterial({ color: PALETTE.ink, gradientMap: gradient }));
    for (const x of [-netHalf, netHalf]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.535, 0);
      post.castShadow = true;
      scene.add(post);
    }
  }

  // ---- Fence (sides and far end) and four light poles.
  const lampMats: THREE.MeshBasicMaterial[] = [];
  {
    const fenceTex = tex(canvasTexture(64, (g, s) => {
      g.clearRect(0, 0, s, s);
      g.strokeStyle = 'rgba(27,27,30,0.75)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(0, 0); g.lineTo(s, s);
      g.moveTo(s, 0); g.lineTo(0, s);
      g.stroke();
    }));
    fenceTex.wrapS = THREE.RepeatWrapping;
    fenceTex.wrapT = THREE.RepeatWrapping;
    const fx = COURT.doublesHalfWidth + 4.2;
    const fz = COURT.halfLength + 6.6;
    const fh = 3.2;
    const fenceMat = (len: number) => {
      const t = fenceTex.clone();
      textures.push(t);
      t.repeat.set(len / 0.5, fh / 0.5);
      t.needsUpdate = true;
      return mat(new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    };
    const fenceGeoFar = geo(new THREE.PlaneGeometry(fx * 2, fh));
    const far = new THREE.Mesh(fenceGeoFar, fenceMat(fx * 2));
    far.position.set(0, fh / 2, -fz);
    scene.add(far);
    const sideLen = fz + 12;
    const sideGeo = geo(new THREE.PlaneGeometry(sideLen, fh));
    const sideMat = fenceMat(sideLen);
    for (const x of [-fx, fx]) {
      const side = new THREE.Mesh(sideGeo, sideMat);
      side.rotation.y = Math.PI / 2;
      side.position.set(x, fh / 2, -fz + sideLen / 2);
      scene.add(side);
    }
    const railGeo = geo(new THREE.BoxGeometry(1, 0.06, 0.06));
    const inkMat = mat(new THREE.MeshToonMaterial({ color: PALETTE.ink, gradientMap: gradient }));
    const topFar = new THREE.Mesh(railGeo, inkMat);
    topFar.scale.x = fx * 2; topFar.position.set(0, fh, -fz);
    scene.add(topFar);
    for (const x of [-fx, fx]) {
      const rail = new THREE.Mesh(railGeo, inkMat);
      rail.scale.x = sideLen; rail.rotation.y = Math.PI / 2; rail.position.set(x, fh, -fz + sideLen / 2);
      scene.add(rail);
    }
    const fencePost = geo(new THREE.CylinderGeometry(0.04, 0.04, fh, 6));
    for (let x = -fx; x <= fx + 0.01; x += fx / 3) {
      const p = new THREE.Mesh(fencePost, inkMat);
      p.position.set(x, fh / 2, -fz);
      scene.add(p);
    }
    for (const x of [-fx, fx]) {
      for (let z = -fz; z <= -fz + sideLen; z += 4) {
        const p = new THREE.Mesh(fencePost, inkMat);
        p.position.set(x, fh / 2, z);
        scene.add(p);
      }
    }

    const poleGeo = geo(new THREE.CylinderGeometry(0.12, 0.16, 9, 8));
    const headGeo = geo(new THREE.BoxGeometry(1.6, 0.7, 0.3));
    const frameGeo = geo(new THREE.BoxGeometry(1.8, 0.9, 0.2));
    for (const [x, z] of [[-fx - 1.5, -fz + 2], [fx + 1.5, -fz + 2], [-fx - 1.5, -2], [fx + 1.5, -2]] as const) {
      const pole = new THREE.Mesh(poleGeo, inkMat);
      pole.position.set(x, 4.5, z);
      pole.castShadow = true;
      scene.add(pole);
      const frame = new THREE.Mesh(frameGeo, inkMat);
      frame.position.set(x, 9.1, z);
      frame.lookAt(0, 0, z * 0.4);
      scene.add(frame);
      const lampMat = mat(new THREE.MeshBasicMaterial({ color: PALETTE.lampOff }));
      lampMats.push(lampMat);
      const head = new THREE.Mesh(headGeo, lampMat);
      head.position.set(x, 9.1, z);
      head.lookAt(0, 0, z * 0.4);
      head.translateZ(0.06);
      scene.add(head);
    }
  }

  // ---- Players.
  const bodyGeo = geo(new THREE.CapsuleGeometry(0.32, 0.8, 6, 16));
  const outlineGeo = geo(new THREE.CapsuleGeometry(0.355, 0.8, 6, 16));
  const headGeo = geo(new THREE.SphereGeometry(0.2, 16, 12));
  const headOutlineGeo = geo(new THREE.SphereGeometry(0.228, 16, 12));
  const brimGeo = geo(new THREE.BoxGeometry(0.26, 0.035, 0.22));
  const armGeo = geo(new THREE.CylinderGeometry(0.045, 0.045, 0.34, 8).rotateX(Math.PI / 2).translate(0, 0, 0.17));
  const handleGeo = geo(new THREE.CylinderGeometry(0.028, 0.028, 0.32, 8).rotateX(Math.PI / 2).translate(0, 0, 0.5));
  const frameRingGeo = geo(new THREE.TorusGeometry(0.24, 0.03, 8, 28).rotateY(Math.PI / 2));
  const stringsGeo = geo(new THREE.CircleGeometry(0.235, 24).rotateY(Math.PI / 2));
  const ringGeo = geo(new THREE.RingGeometry(0.62, 0.74, 40).rotateX(-Math.PI / 2));
  const outlineMat = mat(new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.BackSide }));
  const skinMat = mat(new THREE.MeshToonMaterial({ color: 0xe9c9a3, gradientMap: gradient }));
  const creamToon = mat(new THREE.MeshToonMaterial({ color: PALETTE.cream, gradientMap: gradient }));
  const inkToon = mat(new THREE.MeshToonMaterial({ color: PALETTE.ink, gradientMap: gradient }));
  const stringsMat = mat(new THREE.MeshBasicMaterial({ color: PALETTE.cream, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
  const ringMat = mat(new THREE.MeshBasicMaterial({ color: PALETTE.cream, transparent: true, opacity: 0.8, depthWrite: false }));

  const figures: Figure[] = [];
  for (let i = 0; i < MAX_FIGURES; i++) {
    const root = new THREE.Group();
    const bodyMat = mat(new THREE.MeshToonMaterial({ color: PALETTE.cream, gradientMap: gradient }));
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.72;
    body.castShadow = true;
    const bodyLine = new THREE.Mesh(outlineGeo, outlineMat);
    bodyLine.position.y = 0.72;
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.68;
    head.castShadow = true;
    const headLine = new THREE.Mesh(headOutlineGeo, outlineMat);
    headLine.position.y = 1.68;
    const cap = new THREE.Mesh(brimGeo, inkToon);
    cap.position.set(0, 1.79, 0.17);
    root.add(body, bodyLine, head, headLine, cap);

    const pivot = new THREE.Group();
    pivot.position.set(-0.3, 1.15, 0.05);
    pivot.rotation.order = 'YXZ';
    const arm = new THREE.Mesh(armGeo, skinMat);
    const handle = new THREE.Mesh(handleGeo, inkToon);
    const frameRing = new THREE.Mesh(frameRingGeo, creamToon);
    frameRing.position.z = 0.9;
    frameRing.scale.z = 1.25;
    frameRing.castShadow = true;
    const strings = new THREE.Mesh(stringsGeo, stringsMat);
    strings.position.z = 0.9;
    strings.scale.z = 1.25;
    pivot.add(arm, handle, frameRing, strings);
    root.add(pivot);

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.01;
    ring.visible = false;
    scene.add(ring);

    // Larger than life, like the ball, so figures read from across a room.
    root.scale.setScalar(1.15);
    root.visible = false;
    scene.add(root);
    figures.push({ root, bodyMat, pivot, ring, color: '', yaw: 0, armYaw: -0.5, armPitch: 0.6, lastSwing: null, swingKind: 'forehand', prevX: 0, prevZ: 0, speed: 0 });
  }

  // ---- Ball, blob shadow, trail, landing ring.
  const ballGeo = geo(new THREE.SphereGeometry(COURT.ballDrawRadius, 20, 14));
  const ball = new THREE.Mesh(ballGeo, mat(new THREE.MeshBasicMaterial({ color: PALETTE.ball })));
  const ballLine = new THREE.Mesh(geo(new THREE.SphereGeometry(COURT.ballDrawRadius * 1.25, 16, 10)), outlineMat);
  ball.add(ballLine);
  scene.add(ball);
  const blobTex = tex(canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(27,27,30,1)');
    r.addColorStop(0.55, 'rgba(27,27,30,0.85)');
    r.addColorStop(1, 'rgba(27,27,30,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }));
  const blobMat = mat(new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  const blob = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), blobMat);
  blob.renderOrder = 2;
  scene.add(blob);
  const trail: THREE.Mesh[] = [];
  const trailX = new Float32Array(TRAIL);
  const trailY = new Float32Array(TRAIL);
  const trailZ = new Float32Array(TRAIL);
  let trailCount = 0;
  let trailHead = 0;
  for (let i = 0; i < TRAIL; i++) {
    const m = new THREE.Mesh(ballGeo, mat(new THREE.MeshBasicMaterial({ color: PALETTE.ball, transparent: true, opacity: 0.45 * (1 - i / TRAIL), depthWrite: false })));
    m.scale.setScalar(0.85 * (1 - i / TRAIL) + 0.15);
    m.visible = false;
    trail.push(m);
    scene.add(m);
  }
  const landing = new THREE.Mesh(geo(new THREE.RingGeometry(0.2, 0.3, 32).rotateX(-Math.PI / 2)),
    mat(new THREE.MeshBasicMaterial({ color: PALETTE.ball, transparent: true, opacity: 0.85, depthWrite: false })));
  landing.position.y = 0.012;
  landing.renderOrder = 3;
  landing.visible = false;
  scene.add(landing);

  // ---- Camera state, motion preference.
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  const onMotion = (e: MediaQueryListEvent) => { reduced = e.matches; };
  motionQuery.addEventListener('change', onMotion);

  let camX = 0;
  let camBack = 11;
  let camHeight = 7;
  let camLookZ = -2.5;
  let lastNow = -1;
  let startedAt = -1;
  let shakeUntil = 0;
  const lookAt = new THREE.Vector3();
  const lampDim = new THREE.Color(PALETTE.lampOff);
  const lampLit = new THREE.Color(PALETTE.lampOn);

  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect;
    // Landscape: fixed vertical field. Portrait: widen and pull back so the far court still fits.
    const wanted = (2 * Math.atan(Math.tan((27 * Math.PI) / 180) / aspect) * 180) / Math.PI;
    camera.fov = Math.min(72, Math.max(42, wanted));
    const narrow = Math.max(0, Math.min(1, (1.3 - aspect) / 0.85));
    camBack = 11 + narrow * 4;
    camHeight = 7 + narrow * 9;
    camLookZ = -2.5 + narrow * 3;
    camera.updateProjectionMatrix();
  }

  const damp = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));
  const ease = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  /** Racket pose for a stance: [yawBack, pitchBack, yawThrough, pitchThrough]. */
  const POSE_FOREHAND: readonly number[] = [-2.4, 0.15, 1.2, -0.5];
  const POSE_BACKHAND: readonly number[] = [2.3, 0.15, -1.3, -0.5];
  const POSE_SERVE: readonly number[] = [-0.25, -2.6, 0.9, 1.0];
  function pose(kind: PlayerView['stance']): readonly number[] {
    if (kind === 'backhand') return POSE_BACKHAND;
    if (kind === 'serve') return POSE_SERVE;
    return POSE_FOREHAND;
  }

  function updateFigure(f: Figure, p: PlayerView, view: MatchView, now: number, dt: number): void {
    f.root.visible = true;
    if (p.color !== f.color) { f.bodyMat.color.set(p.color); f.color = p.color; }
    const moved = Math.hypot(p.pos.x - f.prevX, p.pos.z - f.prevZ);
    f.speed = dt > 0 ? damp(f.speed, moved / dt, 10, dt) : f.speed;
    f.prevX = p.pos.x; f.prevZ = p.pos.z;
    const bob = reduced ? 0 : Math.abs(Math.sin(now * 0.018)) * 0.05 * Math.min(1, f.speed / 3);
    f.root.position.set(p.pos.x, bob, p.pos.z);

    // Face the ball; with no ball in play, face across the net.
    let targetYaw = p.side === 'near' ? Math.PI : 0;
    if (view.ball.visible) {
      const dx = view.ball.pos.x - p.pos.x;
      const dz = view.ball.pos.z - p.pos.z;
      if (dx * dx + dz * dz > 0.25) targetYaw = Math.atan2(dx, dz);
    }
    let diff = targetYaw - f.yaw;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    f.yaw += diff * (1 - Math.exp(-8 * dt));
    f.root.rotation.y = f.yaw;

    if (p.lastSwingAt !== f.lastSwing) {
      if (p.lastSwingAt !== null && f.lastSwing !== null && !reduced) {
        const v = view.ball.vel;
        if (v.x * v.x + v.y * v.y + v.z * v.z > 30 * 30) shakeUntil = now + 180;
      }
      f.lastSwing = p.lastSwingAt;
      f.swingKind = p.stance === 'ready' ? 'forehand' : p.stance;
    }
    const since = p.lastSwingAt === null ? Infinity : now - p.lastSwingAt;
    f.pivot.position.x = f.swingKind === 'backhand' && since < SWING_MS + RECOVER_MS ? 0.05 : -0.3;
    if (since >= 0 && since < SWING_MS) {
      const ps = pose(f.swingKind);
      const k = ease(since / SWING_MS);
      f.armYaw = lerp(ps[0], ps[2], k);
      f.armPitch = lerp(ps[1], ps[3], k);
    } else {
      let ty = -0.5;
      let tp = 0.6;
      if (since < SWING_MS + RECOVER_MS) {
        const ps = pose(f.swingKind);
        ty = ps[2]; tp = ps[3];
      } else if (p.stance === 'serve') {
        ty = -0.25; tp = view.phase === 'toss' ? -2.4 : -1.4;
      } else if (p.receiving && p.stance !== 'ready') {
        const ps = pose(p.stance);
        ty = ps[0] * 0.85; tp = ps[1];
        f.pivot.position.x = p.stance === 'backhand' ? 0.05 : -0.3;
      }
      f.armYaw = damp(f.armYaw, ty, 9, dt);
      f.armPitch = damp(f.armPitch, tp, 9, dt);
    }
    f.pivot.rotation.set(f.armPitch, f.armYaw, 0);

    f.ring.visible = p.receiving;
    if (p.receiving) {
      f.ring.position.x = p.pos.x;
      f.ring.position.z = p.pos.z;
      f.ring.scale.setScalar(reduced ? 1 : 1 + 0.06 * Math.sin(now * 0.006));
    }
  }

  function render(view: MatchView, now: number): void {
    const dt = lastNow < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    if (startedAt < 0) startedAt = now;

    // Floodlights warm up over the first seconds.
    const warm = Math.min(1, (now - startedAt) / 6000);
    for (let i = 0; i < lampMats.length; i++) lampMats[i].color.lerpColors(lampDim, lampLit, warm);

    for (let i = 0; i < MAX_FIGURES; i++) {
      const f = figures[i];
      const p = view.players[i];
      if (p) updateFigure(f, p, view, now, dt);
      else { f.root.visible = false; f.ring.visible = false; }
    }

    const b = view.ball;
    ball.visible = b.visible;
    blob.visible = b.visible;
    if (b.visible) {
      ball.position.set(b.pos.x, Math.max(COURT.ballDrawRadius, b.pos.y), b.pos.z);
      const h = Math.max(0, b.pos.y);
      const s = 0.16 + Math.min(h, 4) * 0.09;
      blob.scale.set(s, 1, s);
      blob.position.set(b.pos.x, 0.006, b.pos.z);
      blobMat.opacity = Math.max(0.2, 0.75 - h * 0.12);

      const lx = trailCount ? trailX[trailHead] : b.pos.x;
      const ly = trailCount ? trailY[trailHead] : b.pos.y;
      const lz = trailCount ? trailZ[trailHead] : b.pos.z;
      const jump = (b.pos.x - lx) ** 2 + (b.pos.y - ly) ** 2 + (b.pos.z - lz) ** 2;
      if (jump > 9) trailCount = 0;
      trailHead = (trailHead + 1) % TRAIL;
      trailX[trailHead] = b.pos.x; trailY[trailHead] = Math.max(COURT.ballDrawRadius, b.pos.y); trailZ[trailHead] = b.pos.z;
      trailCount = Math.min(TRAIL, trailCount + 1);
    } else {
      trailCount = 0;
    }
    for (let i = 0; i < TRAIL; i++) {
      const m = trail[i];
      // Index 0 is the current ball position, so the trail starts one sample back.
      const visible = i + 1 < trailCount;
      m.visible = visible;
      if (visible) {
        const k = (trailHead - (i + 1) + TRAIL) % TRAIL;
        m.position.set(trailX[k], trailY[k], trailZ[k]);
      }
    }
    landing.visible = b.visible && b.landing !== null;
    if (b.landing) landing.position.set(b.landing.x, 0.012, b.landing.z);

    // Camera: behind and above the near baseline, following the ball's x gently.
    // Mostly the ball, partly the near human, so a wide player stays in frame.
    let humanX = 0;
    for (let i = 0; i < view.players.length; i++) {
      const p = view.players[i];
      if (p.side === 'near' && p.human) { humanX = p.pos.x; break; }
    }
    const ballX = b.visible ? Math.max(-4, Math.min(4, b.pos.x)) : 0;
    const target = (reduced ? 0.4 : 1) * (ballX * 0.3 + Math.max(-6, Math.min(6, humanX)) * 0.25);
    camX = damp(camX, target, reduced ? 1.2 : 2.2, dt);
    camera.position.set(camX, camHeight, COURT.halfLength + camBack);
    lookAt.set(camX * 0.5, 0, camLookZ);
    if (!reduced && now < shakeUntil) {
      const k = (shakeUntil - now) / 180;
      camera.position.x += Math.sin(now * 0.11) * 0.05 * k;
      camera.position.y += Math.cos(now * 0.13) * 0.04 * k;
    }
    camera.lookAt(lookAt);

    renderer.render(scene, camera);
  }

  function dispose(): void {
    motionQuery.removeEventListener('change', onMotion);
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    renderer.dispose();
  }

  resize();
  return { render, resize, dispose };
}
