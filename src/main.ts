import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Sky-blue additive tint for the aim-hover glow on grabbable models. */
const HOVER_GLOW = new THREE.Color(0x38bdf8);

/**
 * World-locked 3D loading overlay: progress bar + canvas status text.
 * Shown while a GLB downloads, fades out on completion, turns red on error.
 * Yaw-billboarded every frame so it always faces the user.
 */
class LoadingUI3D extends THREE.Group {
  private bgBar: THREE.Mesh;
  private progressBar: THREE.Mesh;
  private panel: THREE.Mesh;
  private textMesh: THREE.Mesh;
  private textCanvas: HTMLCanvasElement;
  private textCtx: CanvasRenderingContext2D;
  private textTexture: THREE.CanvasTexture;
  private lastText: string = '';
  private mode: 'hidden' | 'loading' | 'done' | 'error' = 'hidden';
  private indeterminate: boolean = false;
  private stateTimer: number = 0;
  private camPos = new THREE.Vector3();

  private readonly BAR_W = 1.0;
  private readonly BAR_H = 0.06;

  constructor() {
    super();

    // Dim backdrop panel for readability in VR void and passthrough
    const panelGeo = new THREE.PlaneGeometry(1.3, 0.62);
    const panelMat = new THREE.MeshBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.panel = new THREE.Mesh(panelGeo, panelMat);
    this.panel.position.z = -0.004;
    this.panel.renderOrder = 998;

    // Bar background (track)
    const bgGeo = new THREE.PlaneGeometry(this.BAR_W, this.BAR_H);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x334155,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.bgBar = new THREE.Mesh(bgGeo, bgMat);
    this.bgBar.position.y = -0.12;
    this.bgBar.renderOrder = 999;

    // Active progress bar — geometry shifted so scale.x grows left-to-right
    const barGeo = new THREE.PlaneGeometry(this.BAR_W, this.BAR_H);
    barGeo.translate(this.BAR_W / 2, 0, 0);
    const barMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.progressBar = new THREE.Mesh(barGeo, barMat);
    this.progressBar.position.set(-this.BAR_W / 2, -0.12, 0.002);
    this.progressBar.scale.x = 0;
    this.progressBar.renderOrder = 1000;

    // Canvas-backed status text (filename + percent / state)
    this.textCanvas = document.createElement('canvas');
    this.textCanvas.width = 512;
    this.textCanvas.height = 160;
    const ctx = this.textCanvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for LoadingUI3D');
    this.textCtx = ctx;
    this.textTexture = new THREE.CanvasTexture(this.textCanvas);
    this.textTexture.colorSpace = THREE.SRGBColorSpace;
    const textGeo = new THREE.PlaneGeometry(1.1, 0.34);
    const textMat = new THREE.MeshBasicMaterial({
      map: this.textTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.textMesh = new THREE.Mesh(textGeo, textMat);
    this.textMesh.position.y = 0.1;
    this.textMesh.renderOrder = 1001;

    this.add(this.panel, this.bgBar, this.progressBar, this.textMesh);
    this.visible = false;
  }

  /** Place in front of the camera at eye level and start showing progress. */
  public show(label: string, camera: THREE.Camera): void {
    camera.getWorldPosition(this.camPos);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    this.position.copy(this.camPos).addScaledVector(dir, 1.5);
    this.position.y = this.camPos.y;

    this.mode = 'loading';
    this.indeterminate = false;
    this.stateTimer = 0;
    this.progressBar.scale.x = 0;
    (this.progressBar.material as THREE.MeshBasicMaterial).color.set(0x38bdf8);
    this.setGroupOpacity(1);
    this.drawText(label, '0%');
    this.visible = true;
  }

  /** percent 0-100, or null when total size is unknown (indeterminate pulse). */
  public updateProgress(label: string, percent: number | null): void {
    if (this.mode !== 'loading') return;
    if (percent === null) {
      this.indeterminate = true;
      this.drawText(label, '···');
      return;
    }
    this.indeterminate = false;
    const p = THREE.MathUtils.clamp(Math.round(percent), 0, 100);
    this.progressBar.scale.x = p / 100;
    this.drawText(label, `${p}%`);
  }

  public complete(label: string): void {
    if (this.mode !== 'loading') return;
    this.mode = 'done';
    this.stateTimer = 0;
    this.indeterminate = false;
    this.progressBar.scale.x = 1;
    this.drawText(label, '100%');
  }

  public fail(label: string, message: string): void {
    this.mode = 'error';
    this.stateTimer = 0;
    this.indeterminate = false;
    (this.progressBar.material as THREE.MeshBasicMaterial).color.set(0xef4444);
    this.progressBar.scale.x = 1;
    this.setGroupOpacity(1);
    this.drawText(`${label} — FAILED`, message, '#f87171');
    this.visible = true;
  }

  /** Per-frame: yaw billboard + indeterminate pulse + auto fade-out. */
  public tick(timestamp: number, camera: THREE.Camera, dt: number): void {
    if (!this.visible) return;

    // Yaw-only billboard (keeps text upright)
    camera.getWorldPosition(this.camPos);
    const yaw = Math.atan2(this.camPos.x - this.position.x, this.camPos.z - this.position.z);
    this.rotation.set(0, yaw, 0);

    if (this.mode === 'loading' && this.indeterminate) {
      const t = (timestamp / 1000) % 1.4 / 1.4;
      this.progressBar.scale.x = 0.25 + 0.2 * Math.sin(t * Math.PI * 2);
      this.progressBar.position.x = -this.BAR_W / 2 + t * this.BAR_W * 0.55;
    } else if (this.mode === 'loading') {
      this.progressBar.position.x = -this.BAR_W / 2;
    }

    if (this.mode === 'done') {
      this.stateTimer += dt;
      if (this.stateTimer > 0.45) {
        const fade = 1 - Math.min((this.stateTimer - 0.45) / 0.4, 1);
        this.setGroupOpacity(fade);
        if (fade <= 0) {
          this.visible = false;
          this.mode = 'hidden';
        }
      }
    } else if (this.mode === 'error') {
      this.stateTimer += dt;
      if (this.stateTimer > 5) {
        this.visible = false;
        this.mode = 'hidden';
      }
    }
  }

  private setGroupOpacity(o: number): void {
    (this.panel.material as THREE.MeshBasicMaterial).opacity = 0.72 * o;
    (this.bgBar.material as THREE.MeshBasicMaterial).opacity = 0.9 * o;
    (this.progressBar.material as THREE.MeshBasicMaterial).opacity = 0.95 * o;
    (this.textMesh.material as THREE.MeshBasicMaterial).opacity = o;
  }

  private drawText(label: string, mainLine: string, color = '#f8fafc'): void {
    const short = label.length > 34 ? `…${label.slice(-33)}` : label;
    const key = `${short}|${mainLine}|${color}`;
    if (key === this.lastText) return;
    this.lastText = key;

    const c = this.textCtx;
    c.clearRect(0, 0, 512, 160);
    c.textAlign = 'center';
    c.fillStyle = '#94a3b8';
    c.font = '600 30px "Space Grotesk", sans-serif';
    c.fillText('LOADING 3D MODEL', 256, 44);
    c.fillStyle = color;
    c.font = '500 34px "JetBrains Mono", monospace';
    c.fillText(short, 256, 88);
    c.fillStyle = mainLine === '···' ? '#38bdf8' : color;
    c.font = '700 44px "JetBrains Mono", monospace';
    c.fillText(mainLine, 256, 140);
    this.textTexture.needsUpdate = true;
  }
}

/**
 * Spatial Viewer Architecture
 * - Manages WebXR Session on Meta Quest 3
 * - Provides 1-hand translation & 6DoF orientation
 * - Provides 2-hand two-point scaling (clamped) & Y-axis rotation
 * - Maintains 100% world-locked spatial anchoring when released
 */
class WebXRGLBViewer {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  // Controllers & Interaction
  private controllers: THREE.XRTargetRaySpace[] = [];
  private controllerGrips: THREE.XRGripSpace[] = [];
  private rayLines: THREE.Line[] = [];
  private rayReticles: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private tempMatrix = new THREE.Matrix4();

  // Model & Anchoring
  private modelRoot: THREE.Group;
  private normalizedScale: number = 1; // per-model 1.0x reference (scale limits are relative to this)
  private boundingBoxHelper: THREE.BoxHelper | null = null;
  private gltfLoader: GLTFLoader;
  private dracoLoader: DRACOLoader;
  private loadingUI: LoadingUI3D;
  private loadToken: number = 0;

  // Environment & Passthrough (MR / VR) State
  private isPassthrough: boolean = false;
  private prevButtonAState: boolean = false;
  // B/Y dual-role: tap = reset pose, hold 1.2s = exit VR to the 2D page
  private readonly B_EXIT_HOLD_MS = 1200;
  private bPressStart: number = 0;
  private bExitFired: boolean = false;
  private bHalfTick: boolean = false;
  private bPad: Gamepad | null = null;
  private vrSkyDome!: THREE.Mesh;
  private grid!: THREE.GridHelper;
  private pedestal!: THREE.Mesh;
  private vrBackgroundColor = new THREE.Color(0x090d16);
  private vrFog = new THREE.FogExp2(0x090d16, 0.08);

  // Manipulation State
  private activeGrabs: Map<THREE.XRTargetRaySpace, {
    controller: THREE.XRTargetRaySpace;
    initialDistance: number;
    initialControllerPos: THREE.Vector3;
    initialModelPos: THREE.Vector3;
    initialModelRot: THREE.Quaternion;
  }> = new Map();

  // Two-hand manipulation cache (full 3-axis rotation & scale)
  private twoHandState: {
    initialDistance: number;
    initialMidpoint: THREE.Vector3;
    initialDir: THREE.Vector3;
    initialControllerUp: THREE.Vector3;
    initialModelScale: THREE.Vector3;
    initialModelPos: THREE.Vector3;
    initialModelQuat: THREE.Quaternion;
    // EMA filtered controller positions (grip space)
    filteredP1: THREE.Vector3;
    filteredP2: THREE.Vector3;
    emaAlpha: number;
    // Cascaded scale smoothing (buttery pinch-zoom without steps)
    smoothedDistance: number;
    smoothedRatio: number;
    prevRawDist: number;
  } | null = null;

  // Smoothing state
  private lastTimestamp: number = 0;
  private targetPos = new THREE.Vector3();
  private targetQuat = new THREE.Quaternion();
  private targetScale = new THREE.Vector3();
  private hasTarget: boolean = false;

  // Dedicated scratch objects (one per role — NEVER alias two live values in the same var)
  private sRaw1 = new THREE.Vector3();
  private sRaw2 = new THREE.Vector3();
  private sMid = new THREE.Vector3();
  private sDir = new THREE.Vector3();
  private sUp1 = new THREE.Vector3();
  private sUp2 = new THREE.Vector3();
  private sAvg = new THREE.Vector3();
  private sProj = new THREE.Vector3();
  private sOff = new THREE.Vector3();
  private sOff2 = new THREE.Vector3();
  private sCross = new THREE.Vector3();
  private sTransUp = new THREE.Vector3();
  private sQDir = new THREE.Quaternion();
  private sQTwist = new THREE.Quaternion();
  private sQTotal = new THREE.Quaternion();
  private sQTmp = new THREE.Quaternion();

  // Smoothing constants (Meta Quest 3 best practices)
  // Scale path tuned for LOW LATENCY: fast stages, anti-step guards kept
  // (freeze-eps + slew limit) so responsiveness doesn't bring back steps.
  private readonly SMOOTH_K_SCALE = 35;    // Final scale ease (input already smoothed upstream)
  private readonly SMOOTH_K_POS_ROT = 22;  // Position/Rotation: smoother
  private readonly SMOOTH_K_DIST = 25;     // Stage 1: smooths raw hand distance (jitter filter)
  private readonly SMOOTH_K_RATIO = 22;    // Stage 2: smooths scale ratio (removes steps)
  private readonly MAX_RATIO_RATE = 8.0;   // Slew limit: ratio units per second (kills spikes, frees fast pinches)
  private readonly DIST_FREEZE_EPS = 0.0004; // Sub-perceptual freeze (0.4mm): kills rest jitter invisibly
  private readonly EMA_ALPHA = 0.45;       // Grip-position EMA: responsive, residual noise caught downstream

  // Desktop / Quest-browser-2D model grab/pan — SINGLE primary button only
  // (button 0: PC left-click == Quest controller trigger). Touch: single finger
  // reports button 0, so it flows through the same path automatically.
  private desktopDrag: {
    pointerId: number;
    grabOffset: THREE.Vector3;
    plane: THREE.Plane;
  } | null = null;
  private dragNdc = new THREE.Vector2();
  private dragHit = new THREE.Vector3();
  private dragDelta = new THREE.Vector3();

  // Non-VR two-controller scale via Gamepad API (Quest 2D browser only:
  // no 6DoF poses outside XR, so delta comes from thumbsticks while both
  // trigger/grip are held). Silently inactive when no pads are exposed.
  private desktopScale: { ratio: number } | null = null;
  private desktopAngVel = new THREE.Vector3(); // smoothed pitch/yaw/roll rad/s
  private readonly DESKTOP_SCALE_RATE = 0.9; // ratio units/sec at full stick deflection
  private readonly DESKTOP_ANG_RATE = 1.6; // rad/sec at full stick deflection
  private readonly DESKTOP_ANG_K = 12; // angular velocity easing (no steps)
  private readonly DESKTOP_STICK_DEADZONE = 0.18;
  private debugPads: boolean = false;

  // VR UX package: aim highlight, scale haptics, bring-to-me, B/Y reset
  private aimHover: boolean = false;
  private highlightMats: { mat: THREE.MeshStandardMaterial; base: THREE.Color }[] = [];
  private lastTapTime: number[] = [0, 0];
  private readonly DOUBLE_TAP_MS = 350;
  private recallAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private readonly RECALL_DUR = 0.35;
  private readonly RECALL_DIST = 0.6;
  private lastScaleRatio: number = 1;
  private scaleHapticCooldown: number = 0;
  private prevButtonBState: boolean = false;
  private recallFrom = new THREE.Vector3();
  private recallTo = new THREE.Vector3();

  // Status HUD elements
  private statusDot: HTMLElement | null;
  private statusText: HTMLElement | null;

  constructor() {
    const containerEl = document.getElementById('canvas-container');
    if (!containerEl) {
      throw new Error('Canvas container element not found');
    }
    this.container = containerEl;
    this.statusDot = document.getElementById('status-dot');
    this.statusText = document.getElementById('status-text');

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = this.vrBackgroundColor;
    this.scene.fog = this.vrFog;

    // 2. Camera setup
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.05,
      50
    );
    this.camera.position.set(0, 1.4, 1.6);

    // 3. WebGLRenderer & WebXR Configuration (alpha: true required for Quest 3 camera passthrough)
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Enable WebXR
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.container.appendChild(this.renderer.domElement);

    // Setup WebXR Session Button (supports immersive-ar on Quest 3 for native passthrough)
    this.setupWebXRButton();

    // 4. Desktop OrbitControls (disabled automatically during XR sessions)
    // Explicit button map (== three.js defaults, pinned for PC <-> Quest 2D parity)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.target.set(0, 1.3, -1.2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.update();

    // 5. Model Container Root (World-Locked Entity)
    this.modelRoot = new THREE.Group();
    this.modelRoot.position.set(0, 1.3, -1.2);
    this.scene.add(this.modelRoot);

    // 6. Loader setup with Draco mesh-compression support
    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/gltf/');
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    // 6b. In-scene 3D loading overlay (world-locked progress bar + status)
    this.loadingUI = new LoadingUI3D();
    this.scene.add(this.loadingUI);

    // Initialize environment & WebXR controllers
    this.setupLightingAndEnvironment();
    this.setupControllers();
    this.setupEventListeners();
    this.setupModelLoadingUI();

    // Load initial model (or procedural high-res artifact fallback)
    this.loadDefaultModel();

    // Start render loop
    this.renderer.setAnimationLoop(this.render.bind(this));

    this.updateStatus(true, 'Ready • Enter VR via Quest 3');
  }

  /**
   * Sets up session request supporting immersive-ar (Quest 3 color passthrough) with fallback to immersive-vr
   */
  private async setupWebXRButton(): Promise<void> {
    if ('xr' in navigator && navigator.xr) {
      const xr = navigator.xr;
      const isARSupported = await xr.isSessionSupported('immersive-ar').catch(() => false);
      const isVRSupported = await xr.isSessionSupported('immersive-vr').catch(() => false);

      if (!isARSupported && !isVRSupported) {
        this.showXRNotSupported();
        return;
      }

      const btn = document.createElement('button');
      btn.id = 'VRButton';
      btn.textContent = isARSupported ? 'ENTER VR / PASSTHROUGH' : 'ENTER VR';

      let currentSession: XRSession | null = null;

      const onSessionEnded = () => {
        currentSession = null;
        btn.textContent = isARSupported ? 'ENTER VR / PASSTHROUGH' : 'ENTER VR';
        this.updateStatus(true, 'VR Session Ended');
      };

      const onSessionStarted = async (session: XRSession) => {
        session.addEventListener('end', onSessionEnded);
        await this.renderer.xr.setSession(session);
        btn.textContent = 'EXIT VR';
        currentSession = session;
      };

      btn.onclick = () => {
        if (currentSession === null) {
          const sessionMode: XRSessionMode = isARSupported ? 'immersive-ar' : 'immersive-vr';
          const sessionInit: XRSessionInit = {
            optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
          };
          xr.requestSession(sessionMode, sessionInit).then(onSessionStarted).catch((err) => {
            console.error('Failed to start WebXR session:', err);
            // Fallback to immersive-vr if immersive-ar failed
            if (sessionMode === 'immersive-ar') {
              xr.requestSession('immersive-vr', sessionInit).then(onSessionStarted);
            }
          });
        } else {
          currentSession.end();
        }
      };

      document.body.appendChild(btn);
    } else {
      this.showXRNotSupported();
    }
  }

  private showXRNotSupported(): void {
    const btn = document.createElement('button');
    btn.id = 'VRButton';
    btn.textContent = 'WEBXR NOT SUPPORTED';
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    document.body.appendChild(btn);
  }

  /**
   * Sets up room lighting, soft shadow casting, and a subtle reference floor grid
   */
  private setupLightingAndEnvironment(): void {
    // Hemispherical ambient lighting for soft sky/ground bounce
    const hemiLight = new THREE.HemisphereLight(0xecf8ff, 0x1e293b, 1.4);
    hemiLight.position.set(0, 10, 0);
    this.scene.add(hemiLight);

    // Key directional light with shadows
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(2.5, 4.5, 2.0);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.1;
    dirLight.shadow.camera.far = 15;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    this.scene.add(dirLight);

    // Subtle blue/purple rim fill light
    const fillLight = new THREE.DirectionalLight(0x6366f1, 0.8);
    fillLight.position.set(-3, 2, -2);
    this.scene.add(fillLight);

    // Spatial floor reference
    this.grid = new THREE.GridHelper(10, 20, 0x38bdf8, 0x1e293b);
    this.grid.position.y = 0.001;
    this.scene.add(this.grid);

    // Circular ground pedestal
    const pedestalGeo = new THREE.CircleGeometry(1.6, 48);
    const pedestalMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.8,
      metalness: 0.1,
    });
    this.pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    this.pedestal.rotation.x = -Math.PI / 2;
    this.pedestal.receiveShadow = true;
    this.scene.add(this.pedestal);

    // Full 360 VR Sky Dome (guarantees 100% full VR void occlusion in WebXR AR/VR)
    const skyGeo = new THREE.SphereGeometry(30, 32, 16);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0x090d16,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.vrSkyDome = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.vrSkyDome);
  }

  /**
   * Initializes Quest 3 WebXR Controllers, rays, reticles, and event listeners
   */
  private setupControllers(): void {
    const controllerModelFactory = new XRControllerModelFactory();

    for (let i = 0; i < 2; i++) {
      // 1. Ray space (for pointing and targeting)
      const controller = this.renderer.xr.getController(i);
      controller.userData.index = i;
      this.scene.add(controller);
      this.controllers.push(controller);

      // Event listeners for grab interactions (support both Trigger and Grip)
      // Trigger tap is evaluated first: a double-tap on empty space recalls
      // the model; a grab on the model itself always wins (see onGrabStart).
      controller.addEventListener('selectstart', () => {
        this.onTriggerTap(controller);
        this.onGrabStart(controller);
      });
      controller.addEventListener('selectend', () => this.onGrabEnd(controller));
      controller.addEventListener('squeezestart', () => this.onGrabStart(controller));
      controller.addEventListener('squeezeend', () => this.onGrabEnd(controller));

      // 2. Controller 3D grip model (renders official Quest 3 controller mesh)
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.add(controllerModelFactory.createControllerModel(grip));
      this.scene.add(grip);
      this.controllerGrips.push(grip);

      // 3. Pointer Ray line (laser pointer look)
      const rayGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2.5),
      ]);
      const rayMaterial = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
      });
      const rayLine = new THREE.Line(rayGeometry, rayMaterial);
      rayLine.name = 'ray';
      controller.add(rayLine);
      this.rayLines.push(rayLine);

      // 4. Target reticle at ray tip
      const reticleGeo = new THREE.RingGeometry(0.015, 0.022, 24);
      const reticleMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
      });
      const reticle = new THREE.Mesh(reticleGeo, reticleMat);
      reticle.visible = false;
      this.scene.add(reticle);
      this.rayReticles.push(reticle);
    }
  }

  /**
   * Triggers haptic pulse on Quest 3 Touch Plus controllers
   */
  private triggerHaptic(controller: THREE.XRTargetRaySpace, intensity = 0.5, duration = 40): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    const inputSources = session.inputSources;
    const index = controller.userData.index as number;
    if (inputSources && inputSources[index]?.gamepad?.hapticActuators?.length) {
      inputSources[index].gamepad.hapticActuators[0].pulse(intensity, duration);
    }
  }

  /**
   * Raycasts against the model to detect grab intent or proximity
   */
  private checkModelIntersection(controller: THREE.XRTargetRaySpace): boolean {
    if (this.modelRoot.children.length === 0) return false;

    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

    const intersects = this.raycaster.intersectObjects(this.modelRoot.children, true);
    if (intersects.length > 0) return true;

    // Proximity threshold fallback (0.6m distance check for close grabbing)
    const ctrlPos = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const modelPos = new THREE.Vector3().setFromMatrixPosition(this.modelRoot.matrixWorld);
    return ctrlPos.distanceTo(modelPos) < 0.6;
  }

  /**
   * Trigger double-tap: recalls a lost model to 0.6m in front of the user.
   * Runs before onGrabStart; a real grab on the model always wins because
   * onGrabStart cancels the recall when it attaches (and bringToMe itself
   * refuses while grabbed).
   */
  private onTriggerTap(controller: THREE.XRTargetRaySpace): void {
    const idx = (controller.userData.index as number) ?? 0;
    const now = performance.now();
    if (now - this.lastTapTime[idx] < this.DOUBLE_TAP_MS) {
      this.lastTapTime[idx] = 0;
      this.bringModelToMe(controller);
    } else {
      this.lastTapTime[idx] = now;
    }
  }

  private bringModelToMe(controller: THREE.XRTargetRaySpace): void {
    if (this.activeGrabs.size > 0) return; // user holds it: nothing to recall
    if (this.modelRoot.children.length === 0) return;
    this.camera.getWorldPosition(this.recallTo);
    this.camera.getWorldDirection(this.recallFrom);
    this.recallFrom.y = 0;
    if (this.recallFrom.lengthSq() < 1e-6) this.recallFrom.set(0, 0, -1);
    this.recallFrom.normalize();
    this.recallTo.addScaledVector(this.recallFrom, this.RECALL_DIST);
    this.recallFrom.copy(this.modelRoot.position);
    if (!Number.isFinite(this.recallTo.x + this.recallTo.y + this.recallTo.z)) return;
    this.recallAnim = {
      from: this.recallFrom.clone(),
      to: this.recallTo.clone(),
      t: 0,
    };
    this.triggerHaptic(controller, 0.5, 40);
    this.updateStatus(true, 'Recalling Model • Bring To Me');
  }

  /** EaseOutCubic recall glide; cancelled by any grab or session end. */
  private stepRecallAnim(dt: number): void {
    if (!this.recallAnim) return;
    if (this.activeGrabs.size > 0 || this.modelRoot.children.length === 0) {
      this.recallAnim = null;
      return;
    }
    this.recallAnim.t += dt;
    const k = Math.min(this.recallAnim.t / this.RECALL_DUR, 1);
    const e = 1 - Math.pow(1 - k, 3);
    this.modelRoot.position.lerpVectors(this.recallAnim.from, this.recallAnim.to, e);
    if (k >= 1) {
      this.recallAnim = null;
      this.updateStatus(true, 'World-Locked • Free 6DoF Walkaround');
    }
  }

  /**
   * Grab interaction start: handles 1-hand initial grab or 2-hand transition
   */
  private onGrabStart(controller: THREE.XRTargetRaySpace): void {
    if (this.activeGrabs.has(controller)) return;

    const hit = this.checkModelIntersection(controller);
    if (!hit && this.activeGrabs.size === 0) {
      return;
    }

    this.recallAnim = null; // a real grab always wins over a recall glide
    this.triggerHaptic(controller, 0.6, 50);

    const ctrlPos = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const modelWorldPos = new THREE.Vector3().setFromMatrixPosition(this.modelRoot.matrixWorld);
    const modelWorldRot = new THREE.Quaternion().setFromRotationMatrix(this.modelRoot.matrixWorld);

    this.activeGrabs.set(controller, {
      controller,
      initialDistance: ctrlPos.distanceTo(modelWorldPos),
      initialControllerPos: ctrlPos,
      initialModelPos: modelWorldPos,
      initialModelRot: modelWorldRot,
    });

    if (this.activeGrabs.size === 1) {
      // 1-Hand Manipulation: Attach model to the controller so it translates & rotates in 6DoF
      controller.attach(this.modelRoot);
      this.updateStatus(true, 'Manipulating (1-Hand 6DoF)');
    } else if (this.activeGrabs.size === 2) {
      // 2-Hand Manipulation: Detach from single controller and anchor into scene for dual-point calculation
      this.scene.attach(this.modelRoot);

      const [c1, c2] = Array.from(this.activeGrabs.keys());
      const idx1 = c1.userData.index as number;
      const idx2 = c2.userData.index as number;

      // Use GRIP SPACE (physical controller pose) for manipulation - Meta best practice
      // NOTE: fresh locals here (runs once per grab, no perf concern) to avoid any aliasing bugs
      const grip1 = this.controllerGrips[idx1];
      const grip2 = this.controllerGrips[idx2];
      const p1 = new THREE.Vector3().setFromMatrixPosition(grip1.matrixWorld);
      const p2 = new THREE.Vector3().setFromMatrixPosition(grip2.matrixWorld);

      const dist = Math.max(p1.distanceTo(p2), 0.05);
      const midpoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(p2, p1).normalize();

      // Average up orientation of both controllers in world space (from grip space)
      const q1 = new THREE.Quaternion().setFromRotationMatrix(grip1.matrixWorld);
      const q2 = new THREE.Quaternion().setFromRotationMatrix(grip2.matrixWorld);
      const up1 = new THREE.Vector3(0, 1, 0).applyQuaternion(q1);
      const up2 = new THREE.Vector3(0, 1, 0).applyQuaternion(q2);
      const avgUp = new THREE.Vector3().addVectors(up1, up2);
      if (avgUp.lengthSq() < 1e-8) avgUp.set(0, 1, 0);
      avgUp.normalize();
      const projUp = avgUp.clone().sub(dir.clone().multiplyScalar(avgUp.dot(dir)));
      if (projUp.lengthSq() > 0.0001) {
        projUp.normalize();
      } else {
        projUp.set(0, 1, 0);
      }

      // EMA alpha for 72Hz Quest 3: 0.45 settles in ~1-2 frames
      // (residual jitter is caught by the distance/ratio stages downstream)
      const emaAlpha = this.EMA_ALPHA;

      this.twoHandState = {
        initialDistance: dist,
        initialMidpoint: midpoint.clone(),
        initialDir: dir.clone(),
        initialControllerUp: projUp.clone(),
        initialModelScale: this.modelRoot.scale.clone(),
        initialModelPos: this.modelRoot.position.clone(),
        initialModelQuat: this.modelRoot.quaternion.clone(),
        // Initialize EMA with current grip positions
        filteredP1: p1.clone(),
        filteredP2: p2.clone(),
        emaAlpha,
        // Scale cascade starts settled (ratio 1:1, no jump on grab)
        smoothedDistance: dist,
        smoothedRatio: 1,
        prevRawDist: dist,
      };
      this.lastScaleRatio = 1;
      this.scaleHapticCooldown = 0;

      this.updateStatus(true, 'Two-Hand 3D Rotating & Scaling');
    }
  }

  /**
   * Grab interaction end: World-locks the object strictly into scene space
   */
  private onGrabEnd(controller: THREE.XRTargetRaySpace): void {
    if (!this.activeGrabs.has(controller)) return;

    this.triggerHaptic(controller, 0.4, 30);
    this.activeGrabs.delete(controller);

    if (this.activeGrabs.size === 1) {
      // One controller still held: switch back to single-hand attachment
      this.twoHandState = null;
      const remainingController = Array.from(this.activeGrabs.keys())[0];
      remainingController.attach(this.modelRoot);
      this.updateStatus(true, 'Manipulating (1-Hand 6DoF)');
    } else if (this.activeGrabs.size === 0) {
      // Released completely: Attach firmly back to scene to maintain strict WORLD-LOCKED status
      this.scene.attach(this.modelRoot);
      this.twoHandState = null;
      this.updateStatus(true, 'World-Locked • Free 6DoF Walkaround');
    }
  }

  /**
   * Per-frame manipulation logic during two-hand gestures:
   * Uses GRIP SPACE with EMA filtering for stable tracking (Meta best practice).
   * Scale path is a 3-stage cascade (EMA positions -> smoothed distance ->
   * slew-limited ratio) so pinch-zoom feels continuous, never stepped.
   */
  private updateTwoHandTransform(dt: number): void {
    if (!this.twoHandState || this.activeGrabs.size < 2) return;
    const st = this.twoHandState;

    const [c1, c2] = Array.from(this.activeGrabs.keys());
    const idx1 = c1.userData.index as number;
    const idx2 = c2.userData.index as number;

    // Use GRIP SPACE (physical controller pose) - more stable than target-ray
    const grip1 = this.controllerGrips[idx1];
    const grip2 = this.controllerGrips[idx2];

    // Get raw grip positions (dedicated scratch, no aliasing)
    this.sRaw1.setFromMatrixPosition(grip1.matrixWorld);
    this.sRaw2.setFromMatrixPosition(grip2.matrixWorld);
    if (!Number.isFinite(this.sRaw1.lengthSq() + this.sRaw2.lengthSq())) return;

    // 1. EMA filtering on controller positions (filters tracking jitter at source)
    const alpha = this.twoHandState.emaAlpha;
    this.twoHandState.filteredP1.lerp(this.sRaw1, alpha);
    this.twoHandState.filteredP2.lerp(this.sRaw2, alpha);

    const p1 = this.twoHandState.filteredP1;
    const p2 = this.twoHandState.filteredP2;

    // 2. Current geometry between FILTERED controller positions
    const rawDist = Math.max(p1.distanceTo(p2), 0.05);
    this.sMid.addVectors(p1, p2).multiplyScalar(0.5);
    this.sDir.subVectors(p2, p1);
    if (this.sDir.lengthSq() < 1e-10) return; // hands on top of each other: skip frame
    this.sDir.normalize();

    // 3. Cascaded scale smoothing (no hard dead-zone -> no steps):
    //  Stage A: sub-perceptual freeze kills rest jitter invisibly (0.4mm in
    //           hand distance, far below visible scale change).
    let frozenDist = rawDist;
    if (Math.abs(rawDist - st.prevRawDist) < this.DIST_FREEZE_EPS) {
      frozenDist = st.prevRawDist;
    }
    st.prevRawDist = frozenDist;
    //  Stage B: exponential smoothing of the distance itself.
    const aD = 1 - Math.exp(-this.SMOOTH_K_DIST * dt);
    st.smoothedDistance += (frozenDist - st.smoothedDistance) * aD;
    //  Stage C: slew-rate limit on the ratio — continuous glide toward the
    //           target, spikes physically cannot step the scale.
    const rawRatio = THREE.MathUtils.clamp(
      st.smoothedDistance / st.initialDistance, 0.05, 8.0
    );
    const maxStep = this.MAX_RATIO_RATE * dt;
    const aR = 1 - Math.exp(-this.SMOOTH_K_RATIO * dt);
    let step = (rawRatio - st.smoothedRatio) * aR; // exponential ease toward target
    step = THREE.MathUtils.clamp(step, -maxStep, maxStep); // slew limit kills spikes
    st.smoothedRatio = THREE.MathUtils.clamp(st.smoothedRatio + step, 0.05, 8.0);

    // Relative clamp: limits are 0.05x–8.0x OF THE MODEL'S OWN normalized
    // scale (scaleRatio is already clamped). An absolute clamp here broke
    // scaling for models normalizing outside [0.05, 8.0] (huge or tiny GLBs).
    const scaleRatio = st.smoothedRatio;
    const baseScale = st.initialModelScale.x;
    let targetScaleVal = baseScale * scaleRatio;
    if (!Number.isFinite(targetScaleVal) || targetScaleVal <= 0) {
      targetScaleVal = this.modelRoot.scale.x;
    }
    this.targetScale.set(targetScaleVal, targetScaleVal, targetScaleVal);

    // 4. FULL 3D ROTATION (Pitch, Yaw, Roll) using filtered orientations
    // A) 3D Direction vector rotation
    this.sQDir.setFromUnitVectors(this.twoHandState.initialDir, this.sDir);

    // B) Axial roll/twist around sDir vector (wrist roll) - using grip space orientation
    this.sQTmp.setFromRotationMatrix(grip1.matrixWorld);
    this.sUp1.set(0, 1, 0).applyQuaternion(this.sQTmp);
    this.sQTmp.setFromRotationMatrix(grip2.matrixWorld);
    this.sUp2.set(0, 1, 0).applyQuaternion(this.sQTmp);
    this.sAvg.addVectors(this.sUp1, this.sUp2);
    if (this.sAvg.lengthSq() < 1e-8) this.sAvg.set(0, 1, 0);
    this.sAvg.normalize();
    this.sProj.copy(this.sAvg).addScaledVector(this.sDir, -this.sAvg.dot(this.sDir));

    this.sQTwist.identity();
    if (this.sProj.lengthSq() > 0.0001) {
      this.sProj.normalize();
      this.sTransUp.copy(this.twoHandState.initialControllerUp).applyQuaternion(this.sQDir);
      this.sCross.crossVectors(this.sTransUp, this.sProj);
      const dot = THREE.MathUtils.clamp(this.sTransUp.dot(this.sProj), -1, 1);
      const twistAngle = Math.atan2(this.sCross.dot(this.sDir), dot);
      if (Number.isFinite(twistAngle)) {
        this.sQTwist.setFromAxisAngle(this.sDir, twistAngle);
      }
    }

    // Combine direction vector rotation with axial twist
    this.sQTotal.multiplyQuaternions(this.sQTwist, this.sQDir);

    // Compute target rotation
    this.targetQuat.copy(this.sQTotal).multiply(this.twoHandState.initialModelQuat);
    if (!Number.isFinite(this.targetQuat.x + this.targetQuat.y + this.targetQuat.z + this.targetQuat.w)) return;
    this.targetQuat.normalize();

    // 5. Centroid translation: scales and rotates offset relative to hands midpoint
    this.sOff.subVectors(
      this.twoHandState.initialModelPos,
      this.twoHandState.initialMidpoint
    );
    this.sOff2.copy(this.sOff).multiplyScalar(scaleRatio).applyQuaternion(this.sQTotal);
    this.targetPos.copy(this.sMid).add(this.sOff2);

    // Safety: never let the target fly away (would look like "disappears")
    if (!Number.isFinite(this.targetPos.x + this.targetPos.y + this.targetPos.z)) return;
    if (this.targetPos.length() > 20) return;

    this.hasTarget = true;

    // Scale haptics: buzz at the 0.05x/8.0x ends, velocity texture while moving
    this.scaleHapticCooldown -= dt;
    if (this.scaleHapticCooldown <= 0) {
      const atLimit = rawRatio <= 0.05001 || rawRatio >= 7.9999;
      if (atLimit) {
        this.triggerHaptic(c1, 0.8, 45);
        this.triggerHaptic(c2, 0.8, 45);
        this.scaleHapticCooldown = 0.5;
      } else {
        const speed = Math.abs(st.smoothedRatio - this.lastScaleRatio) / Math.max(dt, 1e-4);
        if (speed > 0.6) {
          const intensity = Math.min(0.15 + speed * 0.12, 0.6);
          this.triggerHaptic(c1, intensity, 20);
          this.triggerHaptic(c2, intensity, 20);
          this.scaleHapticCooldown = 0.15;
        }
      }
    }
    this.lastScaleRatio = st.smoothedRatio;
  }

  /**
   * Raycast pointers and interactive visual reticles
   */
  private updateControllerRays(): void {
    for (let i = 0; i < this.controllers.length; i++) {
      const controller = this.controllers[i];
      const reticle = this.rayReticles[i];

      this.tempMatrix.identity().extractRotation(controller.matrixWorld);
      this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

      let hit = false;
      if (this.modelRoot.children.length > 0) {
        const intersects = this.raycaster.intersectObjects(this.modelRoot.children, true);
        if (intersects.length > 0 && intersects[0].point) {
          reticle.position.copy(intersects[0].point);
          reticle.quaternion.setFromRotationMatrix(controller.matrixWorld);
          reticle.visible = true;
          hit = true;
        }
      }

      if (!hit) {
        reticle.visible = false;
      }
      if (hit) this.aimHover = true;
    }
  }

  /**
   * Aim highlight: pulse emissive while a ray hovers the model, steady glow
   * while grabbed, off otherwise. Restores each material's base emissive.
   */
  private glowWasActive: boolean = false;

  private updateHoverHighlight(timestamp: number): void {
    if (this.highlightMats.length === 0) return;
    const grabbed = this.activeGrabs.size > 0;
    const active = this.aimHover || grabbed;
    if (!active && !this.glowWasActive) {
      this.aimHover = false;
      return; // already at base emissive: skip uniform writes
    }
    this.glowWasActive = active;
    const pulse = grabbed
      ? 0.32
      : 0.22 + 0.13 * Math.sin(timestamp / 1000 * 6);
    for (const e of this.highlightMats) {
      if (!active) {
        e.mat.emissive.copy(e.base);
        e.mat.emissiveIntensity = 1;
      } else {
        // Additive sky-blue glow over the author's base emissive
        e.mat.emissive.copy(e.base).lerp(HOVER_GLOW, 0.55);
        e.mat.emissiveIntensity = 1 + pulse;
      }
    }
    this.aimHover = false; // re-armed by updateControllerRays each frame
  }

  /**
   * Normalizes the loaded 3D model: centers bounding box and scales to optimal viewing size (~0.6m)
   */
  private normalizeAndDisplayModel(object: THREE.Object3D): void {
    // Clear previous models
    while (this.modelRoot.children.length > 0) {
      this.modelRoot.remove(this.modelRoot.children[0]);
    }

    // Enable shadows on all child meshes + cache emissive-capable materials
    // for the aim highlight (hover glow)
    this.highlightMats = [];
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          if (std && 'emissive' in std && std.emissive instanceof THREE.Color) {
            if (!this.highlightMats.some((e) => e.mat === std)) {
              this.highlightMats.push({ mat: std, base: std.emissive.clone() });
            }
          }
        }
      }
    });

    // Compute bounding box
    const bbox = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bbox.getCenter(center);
    bbox.getSize(size);

    // Center geometry to local origin
    object.position.sub(center);

    // Normalize scale to fit nicely in 0.65m cube
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetScale = maxDim > 0 ? 0.65 / maxDim : 1.0;
    this.normalizedScale = targetScale;
    this.modelRoot.scale.set(targetScale, targetScale, targetScale);

    // Fresh model = fresh interaction state: drop any stale grab/scale
    // targets so the new model scales cleanly from its own 1.0x reference.
    this.twoHandState = null;
    this.hasTarget = false;
    this.desktopScale = null;
    if (this.desktopDrag) {
      this.desktopDrag = null;
      this.renderer.domElement.style.cursor = '';
    }
    if (!this.renderer.xr.isPresenting) this.controls.enabled = true;

    this.modelRoot.add(object);

    // Reset root position to comfortable eye-level viewing height
    this.modelRoot.position.set(0, 1.3, -1.2);
    this.modelRoot.rotation.set(0, 0, 0);

    // Optional subtle bounding box visual helper
    if (this.boundingBoxHelper) {
      this.scene.remove(this.boundingBoxHelper);
    }
    this.boundingBoxHelper = new THREE.BoxHelper(this.modelRoot, 0x38bdf8);
    (this.boundingBoxHelper.material as THREE.LineBasicMaterial).transparent = true;
    (this.boundingBoxHelper.material as THREE.LineBasicMaterial).opacity = 0.25;
    this.scene.add(this.boundingBoxHelper);

    this.updateStatus(true, 'Model Ready • World-Locked');
  }

  /**
   * Central GLTF fetch: drives the 3D loading overlay via onProgress,
   * guards stale callbacks with a load token, then routes to handlers.
   */
  private startGltfLoad(
    url: string,
    label: string,
    onSuccess: (gltf: { scene: THREE.Object3D }) => void,
    onError: (err: unknown) => void
  ): void {
    const token = ++this.loadToken;
    this.loadingUI.show(label, this.camera);
    this.updateStatus(false, `Loading ${label}...`);

    this.gltfLoader.load(
      url,
      (gltf) => {
        if (token !== this.loadToken) return; // superseded by a newer request
        this.loadingUI.complete(label);
        onSuccess(gltf);
      },
      (xhr) => {
        if (token !== this.loadToken) return;
        const percent =
          xhr.total > 0 ? Math.round((xhr.loaded / xhr.total) * 100) : null;
        this.loadingUI.updateProgress(label, percent);
        this.updateStatus(
          false,
          percent === null ? `Loading ${label}...` : `Loading ${label}... ${percent}%`
        );
      },
      (err) => {
        if (token !== this.loadToken) return;
        onError(err);
      }
    );
  }

  /**
   * Loads a GLB model from a URL or fallback procedural artifact
   */
  public loadModelFromUrl(url: string): void {
    const label = url.split('/').pop()?.split('?')[0] || '3D Model';
    this.startGltfLoad(
      url,
      label,
      (gltf) => {
        this.normalizeAndDisplayModel(gltf.scene);
      },
      (err) => {
        console.warn(`Could not load GLB from ${url}:`, err);
        this.loadingUI.fail(label, 'network / parse error');
        // Fallback: Generate an attractive procedural 3D sci-fi inspection artifact
        const artifact = this.createProceduralArtifact();
        this.normalizeAndDisplayModel(artifact);
      }
    );
  }

  /**
   * Loads the initial default model
   */
  private loadDefaultModel(): void {
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
    const initialUrl = modelSelect ? modelSelect.value : '/models/Van_v02.glb';
    this.loadModelFromUrl(initialUrl);
  }

  /**
   * Creates an intricate sci-fi orbital crystal artifact for immediate out-of-the-box VR inspection
   */
  private createProceduralArtifact(): THREE.Group {
    const group = new THREE.Group();

    // Central faceted crystal
    const crystalGeo = new THREE.IcosahedronGeometry(0.3, 0);
    const crystalMat = new THREE.MeshPhysicalMaterial({
      color: 0x38bdf8,
      metalness: 0.2,
      roughness: 0.1,
      transmission: 0.6,
      thickness: 0.5,
      emissive: 0x0284c7,
      emissiveIntensity: 0.2,
    });
    const crystal = new THREE.Mesh(crystalGeo, crystalMat);
    group.add(crystal);

    // Inner wireframe glow
    const wireGeo = new THREE.IcosahedronGeometry(0.305, 1);
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x818cf8,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
    });
    group.add(new THREE.Mesh(wireGeo, wireMat));

    // Outer orbital ring
    const ringGeo = new THREE.TorusGeometry(0.45, 0.015, 16, 64);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.9,
      roughness: 0.2,
    });
    const ring1 = new THREE.Mesh(ringGeo, ringMat);
    ring1.rotation.x = Math.PI / 3;
    group.add(ring1);

    const ring2 = new THREE.Mesh(ringGeo, ringMat);
    ring2.rotation.y = Math.PI / 4;
    group.add(ring2);

    return group;
  }

  /**
   * Configures Load Custom GLB file selector, model dropdown, and Reset button
   */
  private setupModelLoadingUI(): void {
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
    const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
    const btnLoad = document.getElementById('btn-load-custom');
    const btnReset = document.getElementById('btn-reset-pos');

    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        this.loadModelFromUrl(modelSelect.value);
      });
    }

    if (btnLoad && fileInput) {
      btnLoad.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e: Event) => {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
          const file = files[0];
          const url = URL.createObjectURL(file);

          if (modelSelect) {
            const opt = document.createElement('option');
            opt.value = url;
            opt.textContent = `Custom: ${file.name}`;
            opt.selected = true;
            modelSelect.appendChild(opt);
          }

          this.startGltfLoad(
            url,
            file.name,
            (gltf) => {
              this.normalizeAndDisplayModel(gltf.scene);
            },
            (err) => {
              console.error('Failed to load custom GLB:', err);
              this.loadingUI.fail(file.name, 'invalid .glb / .gltf');
              this.updateStatus(false, 'Failed to load GLB file');
            }
          );
        }
      });
    }

    if (btnReset) {
      btnReset.addEventListener('click', () => this.resetModelPose());
    }
  }

  /**
   * Toggles between Virtual VR Void and Real-World Passthrough mode
   * In Passthrough mode, only the 3D model and world are visible
   */
  public togglePassthrough(): void {
    this.isPassthrough = !this.isPassthrough;

    const btnToggle = document.getElementById('btn-toggle-passthrough');

    if (this.isPassthrough) {
      // PASSTHROUGH MODE: Hide virtual environment, sky dome, grid, pedestal & fog
      // Only the 3D model remains visible over real-world video feed
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      this.scene.fog = null;
      if (this.vrSkyDome) this.vrSkyDome.visible = false;
      if (this.grid) this.grid.visible = false;
      if (this.pedestal) this.pedestal.visible = false;
      if (this.boundingBoxHelper) this.boundingBoxHelper.visible = false;

      if (btnToggle) {
        btnToggle.innerHTML = `
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Passthrough Mode: ON (Btn A)`;
        btnToggle.style.background = 'rgba(34, 197, 94, 0.2)';
        btnToggle.style.borderColor = 'rgba(34, 197, 94, 0.6)';
        btnToggle.style.color = '#4ade80';
      }
      this.updateStatus(true, 'Passthrough Mode (Real World View)');
    } else {
      // VR MODE: Restore full 360 VR sky dome, pedestal, grid & atmospheric fog
      this.scene.background = this.vrBackgroundColor;
      this.renderer.setClearColor(0x090d16, 1);
      this.scene.fog = this.vrFog;
      if (this.vrSkyDome) this.vrSkyDome.visible = true;
      if (this.grid) this.grid.visible = true;
      if (this.pedestal) this.pedestal.visible = true;
      if (this.boundingBoxHelper) this.boundingBoxHelper.visible = true;

      if (btnToggle) {
        btnToggle.innerHTML = `
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Passthrough Mode: OFF (Btn A)`;
        btnToggle.style.background = 'rgba(56, 189, 248, 0.15)';
        btnToggle.style.borderColor = 'rgba(56, 189, 248, 0.4)';
        btnToggle.style.color = '#38bdf8';
      }
      this.updateStatus(true, 'Virtual VR Mode (Void)');
    }
  }

  /**
   * Polls Meta Quest 3 controller buttons
   * - Button A (right, buttons[4]): passthrough toggle
   * - Button B/Y (either hand, buttons[5]): reset model pose — no headset-off
   */
  private checkControllerButtons(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    let bPressed = false;
    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      const gamepad = source.gamepad;
      // Quest 3 Right Controller: Button A passthrough toggle
      if (source.handedness === 'right') {
        // In WebXR xr-standard mapping: buttons[4] is the primary face button (Button A)
        const btnA = gamepad.buttons[4];
        if (btnA) {
          const isPressed = btnA.pressed || btnA.value > 0.5;
          if (isPressed && !this.prevButtonAState) {
            this.togglePassthrough();
            // Tactile feedback on Button A press
            if (gamepad.hapticActuators && gamepad.hapticActuators[0]) {
              gamepad.hapticActuators[0].pulse(0.7, 50);
            }
          }
          this.prevButtonAState = isPressed;
        }
      }
      // Secondary face button (B on right / Y on left, buttons[5]):
      // TAP = reset pose, HOLD 1.2s = exit VR to the 2D page. The tap action
      // is deferred until release so a long-press never resets first.
      const btnB = gamepad.buttons[5];
      if (btnB && (btnB.pressed || btnB.value > 0.5)) {
        bPressed = true;
        const now = performance.now();
        if (!this.prevButtonBState) {
          this.bPressStart = now;
          this.bExitFired = false;
          this.bHalfTick = false;
          this.bPad = gamepad;
        } else {
          const heldFor = now - this.bPressStart;
          if (!this.bHalfTick && heldFor >= 600) {
            this.bHalfTick = true;
            gamepad.hapticActuators?.[0]?.pulse(0.4, 30);
            this.updateStatus(true, 'Hold B • Release=Reset, Keep Holding=Exit VR');
          }
          if (!this.bExitFired && heldFor >= this.B_EXIT_HOLD_MS) {
            this.bExitFired = true;
            gamepad.hapticActuators?.[0]?.pulse(1.0, 120);
            this.exitSession();
          }
        }
      }
    }
    // Falling edge: tap (released before the exit threshold, exit not fired)
    if (this.prevButtonBState && !bPressed) {
      if (!this.bExitFired && this.bPressStart > 0 &&
          performance.now() - this.bPressStart < this.B_EXIT_HOLD_MS) {
        this.resetModelPose();
        this.bPad?.hapticActuators?.[0]?.pulse(0.6, 40);
      }
      this.bPressStart = 0;
      this.bPad = null;
    }
    this.prevButtonBState = bPressed;
  }

  /** Ends the immersive session, returning to the non-VR 2D page. */
  private exitSession(): void {
    try {
      const session = this.renderer.xr.getSession();
      if (session) {
        this.updateStatus(true, 'Exiting VR • Back to 2D Page...');
        session.end().catch(() => undefined);
      }
    } catch {
      // already ended: sessionend listener restores desktop state
    }
  }

  /** Restores position + rotation + normalized scale (HUD Reset + B/Y share it). */
  private resetModelPose(): void {
    this.recallAnim = null;
    this.modelRoot.position.set(0, 1.3, -1.2);
    this.modelRoot.rotation.set(0, 0, 0);
    this.modelRoot.scale.set(
      this.normalizedScale,
      this.normalizedScale,
      this.normalizedScale
    );
    this.updateStatus(true, 'Position Reset • World-Locked');
  }

  /**
   * Non-VR model grab (PC mouse == Quest 2D-browser controller laser):
   * hold the SINGLE primary button (button 0: PC left-click == Quest trigger)
   * on the model and drag to PAN it across the camera-facing plane.
   * Capture-phase + stopPropagation so OrbitControls never starts a competing
   * rotate; a press that misses the model falls through to OrbitControls.
   */
  private setupDesktopGrab(): void {
    const el = this.renderer.domElement;

    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // NOTE: capture listener lives on the CONTAINER (parent of the canvas):
    // at-target listeners fire in registration order regardless of capture,
    // and OrbitControls registered first — only an ancestor capture listener
    // can intercept before it. HUD elements are siblings, unaffected.
    this.container.addEventListener(
      'pointerdown',
      (e) => {
        if (this.renderer.xr.isPresenting) return;
        if (e.button !== 0) return; // single grab button only
        if (e.target !== el) return; // HUD/VRButton clicks pass through
        if (this.modelRoot.children.length === 0) return;
        // Second finger/pointer: hand control back to OrbitControls (pinch/rotate)
        if (this.desktopDrag) {
          this.desktopDrag = null;
          this.controls.enabled = true;
          return;
        }

        this.dragNdc.set(
          (e.clientX / window.innerWidth) * 2 - 1,
          -(e.clientY / window.innerHeight) * 2 + 1
        );
        this.raycaster.setFromCamera(this.dragNdc, this.camera);
        const hits = this.raycaster.intersectObjects(this.modelRoot.children, true);
        if (hits.length === 0) return; // missed: OrbitControls handles it

        // Grabbed: claim the gesture before OrbitControls sees it
        e.stopPropagation();
        e.preventDefault();

        // Drag plane: faces the camera through the grab point (screen-space pan)
        this.camera.getWorldDirection(this.dragDelta);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          this.dragDelta.clone(),
          hits[0].point
        );
        const grabOffset = this.modelRoot.position.clone().sub(hits[0].point);
        this.desktopDrag = { pointerId: e.pointerId, grabOffset, plane };
        this.controls.enabled = false;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // capture unsupported: drag still tracks via window-level moves
        }
        el.style.cursor = 'grabbing';
        this.updateStatus(true, 'Desktop Grab • Panning Model');
      },
      { capture: true }
    );

    el.addEventListener('pointermove', (e) => {
      if (!this.desktopDrag || e.pointerId !== this.desktopDrag.pointerId) return;
      if (this.renderer.xr.isPresenting) return;

      this.dragNdc.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      );
      this.raycaster.setFromCamera(this.dragNdc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.desktopDrag.plane, this.dragHit)) {
        if (!Number.isFinite(this.dragHit.x + this.dragHit.y + this.dragHit.z)) return;
        this.modelRoot.position.copy(this.dragHit).add(this.desktopDrag.grabOffset);
        // Keep the model in a sane inspection volume
        this.modelRoot.position.y = Math.max(this.modelRoot.position.y, 0.05);
        if (this.modelRoot.position.length() > 12) {
          this.modelRoot.position.setLength(12);
        }
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.desktopDrag || e.pointerId !== this.desktopDrag.pointerId) return;
      this.desktopDrag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
      this.updateStatus(true, 'World-Locked • Free 6DoF Walkaround');
    };
    const cancelDrag = () => {
      if (!this.desktopDrag) return;
      this.desktopDrag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
      this.updateStatus(true, 'World-Locked • Free 6DoF Walkaround');
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', cancelDrag);
    // Desktop parity for VR double-trigger recall: double-click empty space
    // brings a lost model back (a real grab still wins on the model itself).
    el.addEventListener('dblclick', (e) => {
      if (this.renderer.xr.isPresenting) return;
      if (this.activeGrabs.size > 0 || this.desktopDrag) return;
      this.dragNdc.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      );
      this.raycaster.setFromCamera(this.dragNdc, this.camera);
      const hits = this.raycaster.intersectObjects(this.modelRoot.children, true);
      if (hits.length > 0) return;
      this.camera.getWorldPosition(this.recallTo);
      this.camera.getWorldDirection(this.recallFrom);
      this.recallFrom.y = 0;
      if (this.recallFrom.lengthSq() < 1e-6) this.recallFrom.set(0, 0, -1);
      this.recallFrom.normalize();
      this.recallTo.addScaledVector(this.recallFrom, this.RECALL_DIST);
      this.recallAnim = { from: this.modelRoot.position.clone(), to: this.recallTo.clone(), t: 0 };
      this.updateStatus(true, 'Recalling Model • Bring To Me');
    });
  }

  /**
   * Non-VR two-controller manipulation (Quest 2D browser): trigger or grip
   * held on BOTH controllers enters the mode; sticks drive SCALE + ROTATION
   * of the model, mirroring VR two-hand gestures. No 6DoF poses exist outside
   * XR, so sticks stand in for hand motion. Silently inactive without exposed
   * gamepads. Pad order = browser enumeration (pad[0] yaw+scale, pad[1]
   * pitch+roll); confirm with ?debugpads=1 if axes feel swapped.
   */
  private updateDesktopGamepads(dt: number): void {
    if (this.renderer.xr.isPresenting) {
      this.desktopScale = null;
      this.desktopAngVel.set(0, 0, 0);
      return;
    }
    const pads: Gamepad[] = [];
    try {
      for (const p of navigator.getGamepads()) {
        if (p && p.connected && p.buttons.length >= 2) pads.push(p);
      }
    } catch {
      this.desktopScale = null;
      this.desktopAngVel.set(0, 0, 0);
      return;
    }

    const held = pads.filter((p) => this.padGrabHeld(p));
    if (held.length >= 2) {
      if (!this.desktopScale) {
        this.desktopScale = { ratio: 1 };
        this.updateStatus(true, 'Desktop 2-Hand • Sticks Rotate + Scale');
      }
      const ax = (p: Gamepad, i: number): number => {
        const v = p.axes[i] ?? 0;
        return Number.isFinite(v) ? v : 0;
      };
      const gate = (v: number): number =>
        Math.abs(v) < this.DESKTOP_STICK_DEADZONE ? 0 : v;

      // Scale: averaged right-stick Y of both pads (up = grow)
      let scaleY = 0;
      for (const p of held) {
        scaleY += p.axes.length >= 4 ? ax(p, 3) : ax(p, 1);
      }
      const gatedScale = gate(scaleY / held.length);
      if (gatedScale !== 0) {
        // Relative clamp (0.05x–8.0x of this model's normalized scale),
        // so it works for every GLB no matter its normalized magnitude.
        const base = this.modelRoot.scale.x / this.desktopScale.ratio;
        this.desktopScale.ratio = THREE.MathUtils.clamp(
          this.desktopScale.ratio - gatedScale * this.DESKTOP_SCALE_RATE * dt,
          0.05,
          8.0
        );
        const s = base * this.desktopScale.ratio;
        if (Number.isFinite(s) && s > 0) {
          this.modelRoot.scale.set(s, s, s);
        }
      }

      // Rotation (local space): pad[0].X = yaw, pad[1].Y = pitch,
      // pad[1].X = roll. Angular velocities eased to avoid steps.
      const p0 = held[0];
      const p1 = held[1];
      const yawT = p0.axes.length >= 4 ? gate(ax(p0, 2)) : gate(ax(p0, 0));
      const pitchT = p1.axes.length >= 4 ? gate(ax(p1, 1)) : 0;
      const rollT = p1.axes.length >= 4 ? gate(ax(p1, 0)) : 0;
      const aA = 1 - Math.exp(-this.DESKTOP_ANG_K * dt);
      this.desktopAngVel.y += (yawT * this.DESKTOP_ANG_RATE - this.desktopAngVel.y) * aA;
      this.desktopAngVel.x += (pitchT * this.DESKTOP_ANG_RATE - this.desktopAngVel.x) * aA;
      this.desktopAngVel.z += (-rollT * this.DESKTOP_ANG_RATE - this.desktopAngVel.z) * aA;
      this.modelRoot.rotateY(this.desktopAngVel.y * dt);
      this.modelRoot.rotateX(this.desktopAngVel.x * dt);
      this.modelRoot.rotateZ(this.desktopAngVel.z * dt);
    } else {
      if (this.desktopScale) {
        this.desktopScale = null;
        this.updateStatus(true, 'World-Locked • Free 6DoF Walkaround');
      }
      this.desktopAngVel.set(0, 0, 0);
    }

    if (this.debugPads) this.renderPadDebug(pads);
  }

  /** Trigger (btn 0) or squeeze/grip (btn 1), xr-standard mapping. */
  private padGrabHeld(pad: Gamepad): boolean {
    const b0 = pad.buttons[0];
    const b1 = pad.buttons[1];
    return (
      !!b0 && (b0.pressed || b0.value > 0.5)
    ) || (
      !!b1 && (b1.pressed || b1.value > 0.5)
    );
  }

  /** ?debugpads=1 overlay: live gamepad snapshot to confirm Quest mapping. */
  private renderPadDebug(pads: Gamepad[]): void {
    let el = document.getElementById('pad-debug');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pad-debug';
      el.style.cssText =
        'position:absolute;bottom:84px;right:24px;z-index:50;max-width:46vw;' +
        'background:rgba(0,0,0,0.72);color:#7dd3fc;font:11px/1.5 monospace;' +
        'padding:8px 10px;border-radius:8px;white-space:pre-wrap;pointer-events:none;';
      document.body.appendChild(el);
    }
    const now = performance.now();
    if (now - (this.padDebugLast ?? 0) < 200) return;
    this.padDebugLast = now;
    if (pads.length === 0) {
      el.textContent = 'pads: none — press any controller button once';
      return;
    }
    el.textContent = pads
      .map((p, i) => {
        const btns = p.buttons
          .map((b, bi) => (b.pressed || b.value > 0.05 ? `${bi}:${b.value.toFixed(2)}` : null))
          .filter(Boolean)
          .join(' ');
        const axes = p.axes.map((a) => a.toFixed(2)).join(',');
        return `#${i} ${p.id.slice(0, 28)} map=${p.mapping}\n  btn[${btns || '-'}] ax[${axes}]`;
      })
      .join('\n');
  }
  private padDebugLast: number = 0;

  private setupEventListeners(): void {
    this.setupDesktopGrab();
    try {
      this.debugPads = new URLSearchParams(window.location.search).has('debugpads');
    } catch {
      this.debugPads = false;
    }
    window.addEventListener('resize', this.onWindowResize.bind(this));

    // Keyboard shortcut 'A' or 'P' to toggle passthrough on desktop
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'a' || e.key === 'A' || e.key === 'p' || e.key === 'P') {
        this.togglePassthrough();
      }
    });

    // HUD Button toggle listener
    const btnToggle = document.getElementById('btn-toggle-passthrough');
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        this.togglePassthrough();
      });
    }

    // Detect XR session start / end
    this.renderer.xr.addEventListener('sessionstart', () => {
      this.updateStatus(true, 'Immersive Session Active • Quest 3');
      this.desktopDrag = null;
      this.desktopScale = null;
      this.controls.enabled = false;
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.updateStatus(true, 'Session Ended • Back on 2D Page');
      this.controls.enabled = true;
      // Ensure world lock remains clean upon session exit
      this.scene.attach(this.modelRoot);
      // Drop stale interaction state (e.g. exiting mid-grab via hold-B):
      // selectend/squeezeend never fire for the dead session.
      this.activeGrabs.clear();
      this.twoHandState = null;
      this.hasTarget = false;
      this.recallAnim = null;
      this.desktopScale = null;
      this.desktopAngVel.set(0, 0, 0);
      this.bPressStart = 0;
      this.bExitFired = false;
      this.prevButtonBState = false;
      this.prevButtonAState = false;
    });
  }

  private onWindowResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private updateStatus(active: boolean, message: string): void {
    if (this.statusDot) {
      this.statusDot.classList.toggle('active', active);
    }
    if (this.statusText) {
      this.statusText.textContent = message;
    }
  }

  /**
   * Main WebXR animation and render loop
   */
  private render(timestamp: number, frame: XRFrame | null): void {
    // Calculate deltaTime for frame-rate independent smoothing
    const dt = this.lastTimestamp > 0 ? Math.min((timestamp - this.lastTimestamp) / 1000, 1 / 30) : 1 / 72;
    this.lastTimestamp = timestamp;

    // Process XR inputs and transformations if active
    if (this.renderer.xr.isPresenting) {
      this.checkControllerButtons();
      this.stepRecallAnim(dt);
      this.updateTwoHandTransform(dt);
      this.updateControllerRays();

      // Apply exponential smoothing for fluid two-hand manipulation
      // Separate factors: scale more responsive, position/rotation smoother (Meta UX guidelines)
      if (this.hasTarget && this.activeGrabs.size === 2) {
        const alphaScale = 1 - Math.exp(-this.SMOOTH_K_SCALE * dt);
        const alphaPosRot = 1 - Math.exp(-this.SMOOTH_K_POS_ROT * dt);

        this.modelRoot.position.lerp(this.targetPos, alphaPosRot);
        this.modelRoot.quaternion.slerp(this.targetQuat, alphaPosRot);
        this.modelRoot.scale.lerp(this.targetScale, alphaScale);
      } else {
        this.hasTarget = false;
      }
    } else {
      this.stepRecallAnim(dt);
      this.updateDesktopGamepads(dt);
      if (!this.desktopDrag) this.controls.update();
    }

    // Update bounding box helper
    if (this.boundingBoxHelper && this.boundingBoxHelper.visible) {
      this.boundingBoxHelper.update();
    }

    // Aim highlight runs in and out of VR (restores base emissive on exit)
    this.updateHoverHighlight(timestamp);

    // In-scene loading overlay: billboard, indeterminate pulse, auto fade
    this.loadingUI.tick(timestamp, this.camera, dt);

    this.renderer.render(this.scene, this.camera);
  }
}

// Instantiate application on window load
window.addEventListener('DOMContentLoaded', () => {
  new WebXRGLBViewer();
});
