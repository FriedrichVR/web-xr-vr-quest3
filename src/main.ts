import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
  private boundingBoxHelper: THREE.BoxHelper | null = null;
  private gltfLoader: GLTFLoader;

  // Environment & Passthrough (MR / VR) State
  private isPassthrough: boolean = false;
  private prevButtonAState: boolean = false;
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
  } | null = null;

  // Smoothing state
  private lastTimestamp: number = 0;
  private targetPos = new THREE.Vector3();
  private targetQuat = new THREE.Quaternion();
  private targetScale = new THREE.Vector3();
  private hasTarget: boolean = false;

  // Reusable vectors/quaternions to avoid GC pressure
  private tmpVec1 = new THREE.Vector3();
  private tmpVec2 = new THREE.Vector3();
  private tmpVec3 = new THREE.Vector3();
  private tmpQuat1 = new THREE.Quaternion();
  private tmpQuat2 = new THREE.Quaternion();

  // Smoothing constants (Meta Quest 3 best practices)
  private readonly SMOOTH_K_SCALE = 38;    // Scale: more responsive, less smoothing
  private readonly SMOOTH_K_POS_ROT = 22;  // Position/Rotation: smoother
  private readonly SCALE_DEAD_ZONE = 0.005; // 5mm dead zone for scale stability

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
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.3, -1.2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.update();

    // 5. Model Container Root (World-Locked Entity)
    this.modelRoot = new THREE.Group();
    this.modelRoot.position.set(0, 1.3, -1.2);
    this.scene.add(this.modelRoot);

    // 6. Loader setup
    this.gltfLoader = new GLTFLoader();

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
      controller.addEventListener('selectstart', () => this.onGrabStart(controller));
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
   * Grab interaction start: handles 1-hand initial grab or 2-hand transition
   */
  private onGrabStart(controller: THREE.XRTargetRaySpace): void {
    if (this.activeGrabs.has(controller)) return;

    const hit = this.checkModelIntersection(controller);
    if (!hit && this.activeGrabs.size === 0) {
      return;
    }

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
      const grip1 = this.controllerGrips[idx1];
      const grip2 = this.controllerGrips[idx2];
      const p1 = this.tmpVec1.setFromMatrixPosition(grip1.matrixWorld);
      const p2 = this.tmpVec2.setFromMatrixPosition(grip2.matrixWorld);

      const midpoint = this.tmpVec3.addVectors(p1, p2).multiplyScalar(0.5);
      const dir = this.tmpVec1.subVectors(p2, p1).normalize();

      // Average up orientation of both controllers in world space (from grip space)
      const up1 = this.tmpVec1.set(0, 1, 0).applyQuaternion(
        this.tmpQuat1.setFromRotationMatrix(grip1.matrixWorld)
      );
      const up2 = this.tmpVec2.set(0, 1, 0).applyQuaternion(
        this.tmpQuat1.setFromRotationMatrix(grip2.matrixWorld)
      );
      const avgUp = this.tmpVec1.addVectors(up1, up2).normalize();
      const projUp = this.tmpVec2.copy(avgUp).sub(
        this.tmpVec3.copy(dir).multiplyScalar(avgUp.dot(dir))
      );
      if (projUp.lengthSq() > 0.0001) {
        projUp.normalize();
      } else {
        projUp.set(0, 1, 0);
      }

      // EMA alpha for 72Hz Quest 3: ~0.15 gives ~3-4 frame settling
      const emaAlpha = 0.15;

      this.twoHandState = {
        initialDistance: Math.max(p1.distanceTo(p2), 0.05),
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
      };

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
   * Uses GRIP SPACE with EMA filtering for stable tracking (Meta best practice)
   */
  private updateTwoHandTransform(): void {
    if (!this.twoHandState || this.activeGrabs.size < 2) return;

    const [c1, c2] = Array.from(this.activeGrabs.keys());
    const idx1 = c1.userData.index as number;
    const idx2 = c2.userData.index as number;

    // Use GRIP SPACE (physical controller pose) - more stable than target-ray
    const grip1 = this.controllerGrips[idx1];
    const grip2 = this.controllerGrips[idx2];

    // Get raw grip positions
    const rawP1 = this.tmpVec1.setFromMatrixPosition(grip1.matrixWorld);
    const rawP2 = this.tmpVec2.setFromMatrixPosition(grip2.matrixWorld);

    // 1. EMA filtering on controller positions (filters tracking jitter at source)
    const alpha = this.twoHandState.emaAlpha;
    this.twoHandState.filteredP1.lerp(rawP1, alpha);
    this.twoHandState.filteredP2.lerp(rawP2, alpha);

    const p1 = this.twoHandState.filteredP1;
    const p2 = this.twoHandState.filteredP2;

    // 2. Current geometry between FILTERED controller positions
    const currentDistance = Math.max(p1.distanceTo(p2), 0.05);
    const currentMidpoint = this.tmpVec3.addVectors(p1, p2).multiplyScalar(0.5);
    const currentDir = this.tmpVec1.subVectors(p2, p1).normalize();

    // 3. Dual-hand Pinch / Stretch Scaling with DEAD ZONE (prevents micro-jitter)
    const scaleRatio = currentDistance / this.twoHandState.initialDistance;
    const baseScale = this.twoHandState.initialModelScale.x;
    let targetScaleVal = baseScale * scaleRatio;

    // Dead zone: only update scale if change exceeds threshold
    const scaleDelta = Math.abs(targetScaleVal - this.modelRoot.scale.x);
    if (scaleDelta < this.SCALE_DEAD_ZONE) {
      targetScaleVal = this.modelRoot.scale.x; // Hold current scale
    }
    targetScaleVal = THREE.MathUtils.clamp(targetScaleVal, 0.05, 8.0);
    this.targetScale.set(targetScaleVal, targetScaleVal, targetScaleVal);

    // 4. FULL 3D ROTATION (Pitch, Yaw, Roll) using filtered orientations
    // A) 3D Direction vector rotation
    const qDir = this.tmpQuat1.setFromUnitVectors(
      this.twoHandState.initialDir,
      currentDir
    );

    // B) Axial roll/twist around currentDir vector (wrist roll) - using grip space orientation
    const up1 = this.tmpVec1.set(0, 1, 0).applyQuaternion(
      this.tmpQuat2.setFromRotationMatrix(grip1.matrixWorld)
    );
    const up2 = this.tmpVec2.set(0, 1, 0).applyQuaternion(
      this.tmpQuat2.setFromRotationMatrix(grip2.matrixWorld)
    );
    const avgUp = this.tmpVec1.addVectors(up1, up2).normalize();
    const currentProjUp = this.tmpVec2.copy(avgUp).sub(
      this.tmpVec3.copy(currentDir).multiplyScalar(avgUp.dot(currentDir))
    );

    let qTwist = this.tmpQuat2.identity();
    if (currentProjUp.lengthSq() > 0.0001) {
      currentProjUp.normalize();
      const transformedInitialUp = this.twoHandState.initialControllerUp.clone().applyQuaternion(qDir);
      const cross = this.tmpVec1.crossVectors(transformedInitialUp, currentProjUp);
      const dot = THREE.MathUtils.clamp(transformedInitialUp.dot(currentProjUp), -1, 1);
      const twistAngle = Math.atan2(cross.dot(currentDir), dot);
      qTwist.setFromAxisAngle(currentDir, twistAngle);
    }

    // Combine direction vector rotation with axial twist
    const totalRot = this.tmpQuat1.multiplyQuaternions(qTwist, qDir);

    // Compute target rotation
    this.targetQuat.copy(totalRot).multiply(this.twoHandState.initialModelQuat);

    // 5. Centroid translation: scales and rotates offset relative to hands midpoint
    const initialOffset = this.tmpVec1.subVectors(
      this.twoHandState.initialModelPos,
      this.twoHandState.initialMidpoint
    );
    const scaledOffset = this.tmpVec2.copy(initialOffset).multiplyScalar(scaleRatio).applyQuaternion(totalRot);
    this.targetPos.copy(currentMidpoint).add(scaledOffset);

    this.hasTarget = true;
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
    }
  }

  /**
   * Normalizes the loaded 3D model: centers bounding box and scales to optimal viewing size (~0.6m)
   */
  private normalizeAndDisplayModel(object: THREE.Object3D): void {
    // Clear previous models
    while (this.modelRoot.children.length > 0) {
      this.modelRoot.remove(this.modelRoot.children[0]);
    }

    // Enable shadows on all child meshes
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
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
    this.modelRoot.scale.set(targetScale, targetScale, targetScale);

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
   * Loads a GLB model from a URL or fallback procedural artifact
   */
  public loadModelFromUrl(url: string): void {
    this.updateStatus(false, 'Loading 3D Model...');

    this.gltfLoader.load(
      url,
      (gltf) => {
        this.normalizeAndDisplayModel(gltf.scene);
      },
      undefined,
      (err) => {
        console.warn(`Could not load GLB from ${url}:`, err);
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
          this.updateStatus(false, `Loading ${file.name}...`);
          
          if (modelSelect) {
            const opt = document.createElement('option');
            opt.value = url;
            opt.textContent = `Custom: ${file.name}`;
            opt.selected = true;
            modelSelect.appendChild(opt);
          }

          this.gltfLoader.load(
            url,
            (gltf) => {
              this.normalizeAndDisplayModel(gltf.scene);
            },
            undefined,
            (err) => {
              console.error('Failed to load custom GLB:', err);
              this.updateStatus(false, 'Failed to load GLB file');
            }
          );
        }
      });
    }

    if (btnReset) {
      btnReset.addEventListener('click', () => {
        this.modelRoot.position.set(0, 1.3, -1.2);
        this.modelRoot.rotation.set(0, 0, 0);
        this.updateStatus(true, 'Position Reset • World-Locked');
      });
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
   * Detects Button A on the right controller (buttons[4] in xr-standard)
   */
  private checkControllerButtons(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      // Quest 3 Right Controller
      if (source.handedness === 'right' && source.gamepad) {
        const gamepad = source.gamepad;
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
    }
  }

  private setupEventListeners(): void {
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
      this.controls.enabled = false;
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.updateStatus(true, 'Session Ended');
      this.controls.enabled = true;
      // Ensure world lock remains clean upon session exit
      this.scene.attach(this.modelRoot);
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
      this.updateTwoHandTransform();
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
      this.controls.update();
    }

    // Update bounding box helper
    if (this.boundingBoxHelper && this.boundingBoxHelper.visible) {
      this.boundingBoxHelper.update();
    }

    this.renderer.render(this.scene, this.camera);
  }
}

// Instantiate application on window load
window.addEventListener('DOMContentLoaded', () => {
  new WebXRGLBViewer();
});
