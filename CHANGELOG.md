# 📋 Registro de Seguimiento y Cambios (Changelog)

## 📌 ¿Qué hace esta aplicación?
**WebXR Spatial GLB Inspector** es una aplicación web progresiva y de alto rendimiento optimizada para el navegador de **Meta Quest 3**. Permite cargar, inspeccionar y transformar modelos 3D (`.glb` / `.gltf`) en el espacio físico real (Realidad Mixta / Passthrough) o en un entorno virtual inmersivo (Realidad Virtual / Void), garantizando:

1. **Anclaje Espacial Absoluto (World-Locking 6DoF):** Al soltar el modelo, este permanece rígidamente fijado en las coordenadas del mundo real, permitiendo caminar físicamente alrededor de él e inspeccionarlo desde cualquier ángulo sin desplazamientos involuntarios ni ataduras a la cámara.
2. **Manipulación Natural con Mandos:**
   - **1 Mano (Grip/Trigger):** Traslación y rotación libre en 6 grados de libertad.
   - **2 Manos (Ambos Grips):** Escalado simétrico mediante distancia entre mandos + **rotación 3D simultánea en los 3 ejes (Pitch, Yaw, Roll)** pivotando sobre el centroide.
3. **Alternancia Instantánea de Passthrough (Botón A):** Conmutación en tiempo real entre ver tu habitación real con el objeto flotando o un vacío virtual VR completo.
4. **Deploy Automático en Vercel:** Configuración lista para producción con tipos MIME binarios para modelos 3D y servidor HTTPS local para pruebas en red Wi-Fi.

---

## 📈 Historial Incremental de Cambios

### [v1.3.0] - 2026-10-11
#### ✨ Desktop Grab/Pan + 🧈 Escalado Continuo sin Escalones
- **Escalado a 2 manos sin "incrementos" (causa raíz del escalonado):**
  - Se eliminó el dead-zone duro sobre la escala absoluta (congelaba el valor y al liberarlo saltaba ~0.005 = escalón visible).
  - Nueva cascada de 3 etapas frame-rate independent (`updateTwoHandTransform(dt)`):
    - A) Freeze sub-perceptual de 0.4mm en distancia (mata el jitter en reposo de forma invisible).
    - B) Suavizado exponencial de la distancia (`k=10`).
    - C) Ease exponencial del ratio (`k=8`) + **slew-rate limit** (3.0 ratio/s): el glide es continuo, los picos no pueden escalonar.
  - El lerp final de escala baja de `k=38` a `k=14` (el target ya llega suave, solo remata).
  - La traslación del centroide usa el ratio suavizado (también deja de saltar).
- **Grab/Pan del modelo fuera de VR (browser del Quest / desktop):**
  - Click **izquierdo o derecho** (o un dedo en touch) **sobre el modelo** lo agarra y lo panea en el plano paralelo a la cámara 1:1.
  - Click fuera del modelo = OrbitControls normal (órbita/zoom). Segundo dedo = devuelve el control a OrbitControls (pinch/rotar).
  - Click derecho no abre menú (prevenido solo en el canvas). Clamp de volumen (`y ≥ 0.05`, radio ≤ 12m). Guía agregada al HUD.

### [v1.2.3] - 2026-10-11
#### 🐛 Fix Crítico: Modelo Desaparece al Escalar/Rotar a 2 Manos
- **Causa:** aliasing de vectores temporales reutilizados (`tmpVec1/2/3`): `midpoint`, `dir` y `up` se sobrescribían entre sí en el mismo frame, corrompiendo `twoHandState` inicial y el target por frame (NaN / offsets gigantes).
- **Solución:**
  - Scratch dedicados por rol (`sRaw1/2`, `sMid`, `sDir`, `sUp1/2`, `sAvg`, `sProj`, `sOff`, `sQDir`, `sQTwist`, `sQTotal`) — ningún valor vivo comparte variable.
  - Inicialización del grab a 2 manos con vectores locales frescos (corre una vez, sin riesgo).
  - Guards anti-NaN: skip del frame si `dir` degenera, si el quaternion/target no son finitos, y clamp de `targetPos` a 20m para que el modelo nunca "salga volando".

### [v1.2.0] - 2026-10-10
#### 🚀 Mejoras Clave y Correcciones Críticas
- **Rotación 3D Completa en los 3 Ejes (Two-Hand Grab):**
  - Se sustituyó la rotación unidireccional en Y (Yaw) por una formulación matemática completa de cuaterniones 6DoF.
  - Ahora se descompone el movimiento en:
    - $Q_{\text{dir}}$: Rotación del vector director entre ambos mandos (permite **Pitch** e **Inclinación** 3D).
    - $Q_{\text{twist}}$: Torsión axial de muñecas calculada proyectando los vectores normales de los mandos (**Roll**).
  - El escalado y la rotación pivotan armónicamente alrededor del centroide medio entre ambas manos.
- **Solución al Retorno a VR (Máscara Circular Ocluida):**
  - **Problema:** En sesiones `immersive-ar`, WebXR en Quest 3 proyecta la cámara física debajo del buffer y solo los objetos con geometría 3D opaca ocluyen la cámara (el pedestal circular era lo único visible al volver a VR).
  - **Solución:** Se implementó un **VR Sky Dome** envolvente de 360° (`SphereGeometry(30m)` con caras invertidas `BackSide`). Al apagar el Passthrough, la esfera bloquea el 100% del video de la cámara, devolviendo al usuario al entorno virtual VR completo.

---

### [v1.2.1] - 2026-10-11
#### 🎯 Optimización de Fluidez en Manipulación
- **Suavizado Exponencial Frame-Rate Independent (Two-Hand Grab):**
  - Implementación de interpolación exponencial (lerp/slerp) en posición, rotación y escala durante manipulación a dos manos.
  - Cálculo de `deltaTime` real en el loop de render para suavizado independiente de FPS (72Hz Quest 3 / 90Hz PC).
  - Factor de suavizado `k=25` configurable: elimina jitter de tracking sin lag perceptible.
  - Reutilización de objetos `THREE.Vector3`/`Quaternion` para evitar presión en Garbage Collector y frame drops.

---

### [v1.2.2] - 2026-10-11
#### 🎯 Manipulación Two-Hand Optimizada (Meta Quest 3 Best Practices)
- **Grip Space en lugar de Target-Ray Space:** Usa la pose física del mando (`getControllerGrip`) para manipulación, no el puntero láser. Más estable y preciso según guías de Meta.
- **EMA Filtering en Origen:** Exponential Moving Average (α=0.15) aplicado a posiciones de controladores **antes** de calcular transformaciones. Filtra jitter de tracking a 72Hz nativo.
- **Factores de Suavizado Diferenciados:**
  - Escala: `k=38` (responsivo, sin lag al estirar/encoger)
  - Posición/Rotación: `k=22` (suave, elimina micro-movimientos)
- **Dead Zone en Escalado (5mm):** Ignora cambios menores al threshold, evita "flutter" al mantener manos quietas.
- **Orientaciones desde Grip Space:** Roll/Pitch/Yaw calculados con rotación física del mando, no del rayo.

---

### [v1.1.0] - 2026-10-10
#### ✨ Nuevas Características
- **Modo Passthrough (Realidad Mixta) con Botón A:**
  - Integración del botón físico **A** del mando derecho (`buttons[4]` bajo el estándar WebXR `xr-standard`).
  - Habilitación del modo de sesión `immersive-ar` con canal alfa transparente (`alpha: true`).
  - Pulso de retroalimentación háptica en el mando al pulsar el Botón A.
  - Atajos de teclado en PC (`A` / `P`) y botón visual en la interfaz HUD 2D para alternar Passthrough fuera del visor.

---

### [v1.0.0] - 2026-10-10
#### 🏗️ Arquitectura Inicial y Puesta en Marcha
- **Estructura Base del Proyecto:**
  - Configuración de **Vite**, **TypeScript** estricto y **Three.js**.
  - Plugin `@vitejs/plugin-basic-ssl` con exposición `host: true` para habilitar WebXR sobre HTTPS en la red Wi-Fi local de la Meta Quest 3.
  - Archivo `vercel.json` con cabeceras de caché y tipo MIME `model/gltf-binary`.
- **Motor WebXR y Anclaje Espacial:**
  - Implementación de `modelRoot` y desacoplamiento con `scene.attach()`, logrando World-Locking 6DoF puro.
  - Configuración del espacio de referencia `'local-floor'`.
  - Punteros láser visuales con retículas dinámicas y raycasting hacia el modelo 3D.
  - Carga y normalización automática de modelos (centrado a origen y escala a ~0.65m a nivel de ojos).
  - Selector de modelos preinstalados (`Van_v02.glb`, `GMC Motorhome`, `sample.glb`) e importador de archivos locales desde el navegador.

---

## 🎮 Mapa Resumen de Controles

| Mando / Entrada | Acción | Función en la App |
| :--- | :--- | :--- |
| **Mando Derecho [Botón A]** | Clic simple | Alterna entre **Passthrough (MR)** y **Vacío Virtual (VR)**. |
| **Cualquier Mando [Grip o Trigger]** | Mantener presionado | Agarra y traslada el modelo en 6DoF con una mano. |
| **Ambos Mandos [Grip simultáneo]** | Acercar / Alejar manos | **Escalado** con límites de seguridad (`0.05x` a `8.0x`). |
| **Ambos Mandos [Grip simultáneo]** | Mover / Girar manos | **Rotación 3D total** en los 3 ejes (Pitch, Yaw, Roll). |
| **Soltar Mandos** | Soltar botones | El objeto se bloquea permanentemente en el espacio (**World-Lock**). |
| **Teclado PC** | Tecla `A` o `P` | Alterna el modo Passthrough para pruebas de escritorio. |
