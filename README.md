# Meta Quest 3 • WebXR VR Interactive GLB Viewer with World-Locked Models

A production-ready, high-performance WebXR spatial inspection application built with **Three.js**, **Vite**, and **TypeScript**, specifically designed for **Meta Quest 3** (Meta Quest Browser) and ready for deployment on **Vercel**.

---

## 🌟 Key Features

- **Strict 6DoF World-Locking Spatial Anchoring:**
  - Objects remain permanently stationary in 3D world coordinates when not being actively manipulated.
  - Users can physically walk around the model in roomscale 6DoF space and inspect it from any vantage point without drift, jitter, or camera attachment.
- **Natural Controller Manipulations:**
  - **1-Hand Grab (Grip or Trigger):** Real-time 6DoF translation and rotation relative to controller movement.
  - **2-Hand Grab (Both Grips):** Dual-point centroid tracking, distance-based stretch scaling (clamped between `0.05x` and `8.0x`), and Y-axis yaw rotation.
  - **Release:** Automatically reparents to scene space (`scene.attach()`), preserving world coordinates.
- **Visual Raycasting & Laser Reticle:**
  - Precision pointer rays with dynamic intersection rings and proximity fallback grabbing.
- **Quest 3 Haptic Feedback:**
  - Dual tactile pulses on grab start and release via `gamepad.hapticActuators`.
- **Dynamic 3D Model Swapping & File Loading:**
  - Instant dropdown selection for bundled models.
  - Client-side drag-and-drop / file selector for loading any `.glb` or `.gltf` file directly inside the browser.
  - Automatic model normalization (centers geometry to origin and scales bounding box to comfortable eye-level viewing).
- **Vercel Production Ready:**
  - Includes `vercel.json` configured with correct binary MIME types (`model/gltf-binary`) and static caching.
- **Local HTTPS Development:**
  - Powered by `@vitejs/plugin-basic-ssl` to enable secure WebXR session initiation across local Wi-Fi networks on Meta Quest 3.

---

## 📂 Project Structure

```text
quest3-webxr-glb/
├── package.json          # Dependencies (Three.js, WebXR types, Vite, SSL plugin)
├── tsconfig.json         # TypeScript strict configuration
├── vite.config.ts        # Vite configuration with HTTPS & LAN host exposure
├── vercel.json           # Vercel deployment & GLB binary headers
├── index.html            # WebXR viewport, HUD overlay & styling
├── public/
│   └── models/           # GLB models (Van, GMC Motorhome, Sample Core)
└── src/
    ├── main.ts           # WebXR spatial engine, 6DoF anchoring & manipulation logic
    └── vite-env.d.ts     # Vite and WebXR type declarations
```

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Local Development (with Meta Quest 3)

WebXR **requires HTTPS** when accessed from external devices over the local network. Vite is configured with `@vitejs/plugin-basic-ssl` and `host: true`:

```bash
npm run dev
```

In your terminal, Vite will display your local network URL:
```text
  ➜  Local:   https://localhost:5173/
  ➜  Network: https://192.168.1.XX:5173/
```

1. Put on your **Meta Quest 3**.
2. Open the **Meta Quest Browser**.
3. Type the network HTTPS URL (e.g., `https://192.168.1.XX:5173`).
4. If a self-signed certificate warning appears, click **Advanced** -> **Proceed**.
5. Click **Enter VR**.

---

## 🎮 Controller Interaction Guide

| Action | Quest 3 Controller Gesture | Behavior |
| :--- | :--- | :--- |
| **Toggle Passthrough (MR / VR)** | Press **Button A** (Right Controller) | Toggles real-world color passthrough mode (only 3D model visible) vs virtual dark VR room. |
| **Grab / Move** | Hold **Grip** or **Trigger** on 1 controller | Object attaches to controller in 6DoF space. Move your hand to reposition. |
| **Scale & Rotate** | Hold **Grip** on **Both** controllers simultaneously | Moving controllers apart scales up; moving closer scales down. Rotating hands turns object around Y-axis. |
| **Lock into World**| **Release all** triggers / grips | Re-attaches to world coordinates. Walk around it freely in 6DoF roomscale. |
| **Desktop Mode**   | Mouse Drag / Scroll / Key **A** | OrbitControls preview and keyboard key `A` for passthrough toggle on desktop. |

---

## 🌐 Deploy to Vercel

This repository is pre-configured for one-click Vercel deployment:

```bash
npm run build
```

1. Push your repository to GitHub / GitLab.
2. Import the repository into **Vercel**.
3. Vercel will automatically detect `vite` and execute `npm run build` with output directory `dist`.
4. Open the generated Vercel HTTPS URL on your Quest 3 browser and enter VR immediately!
