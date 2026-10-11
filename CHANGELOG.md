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

### [v1.8.1] - 2026-10-11
#### 🐛 Fix: Overlay Persistente + Rotación Z Rara a 2 Manos
- **Overlay eliminado:** el `BoxHelper` (caja wireframe cyan sobre cada modelo) era el overlay persistente — removido por completo (campo, creación, update por frame y toggles de passthrough). El modelo renderiza limpio; el hover-glow ya se apagaba al agarrar.
- **Rotación Z (causas raíz en el incremental v1.8.0):**
  - **Efecto palanca:** la rotación giraba el vector completo modelo↔centroid → con offsets de grab por proximidad, girar bamboleaba el modelo en arco. Ahora la rotación gira **en el lugar** (desacoplada); la traslación solo sigue al centroid 1:1 + crecimiento de escala.
  - **Deriva por ruido acumulado:** los deltas sumaban el jitter de tracking frame a frame (random walk con fuga entre ejes). Deadbands: dirección 0.0003 rad, twist 0.0025 rad — matan frames de puro ruido sin comerse giros lentos intencionales.

### [v1.8.0] - 2026-10-11
#### ✨ Sin Overlay al Seleccionar + Rotación/Movimiento Directo estilo Meta
- **Glow solo en hover:** el highlight se apaga al agarrar/seleccionar el modelo (look limpio durante la manipulación) y vuelve al apuntar en vacío. Restaura el emisivo base como siempre.
- **Rotación y traslación incrementales (direct manipulation):**
  - Antes: targets calculados en absoluto desde el inicio del grab (sensación de "nado"/deriva + lag acumulado).
  - Ahora: cada frame aplica el **delta de manos** (dirección + roll de muñeca) sobre el target acumulado, y el offset del centroide viaja rotado y reescalado con ese delta — el objeto va rígidamente "en las manos", como en las apps de Meta.
  - Tracking pos/rot `k=22 → 30` (targets ahora exactos, el lerp solo remata). Cascada de escala, EMA, clamps relativos, guards anti-NaN y hápticos sin cambios.
  - Estado simplificado: se eliminan las referencias absolutas iniciales (midpoint/dir/up/pos/quat) a favor de `prevDir/prevMid/prevProjUp/prevTargetScale` con roll-forward y guards de degeneración.

### [v1.7.0] - 2026-10-11
#### 🎮 Manipulación 2-Mandos sin VR + Salida de VR con B (1.2s)
- **Rotar + escalar el modelo sin VR (Gamepad API, Quest 2D browser):**
  - Con trigger/grip en **ambos** mandos: stick derecho X = yaw, stick derecho Y = escala (existente), stick izquierdo Y = pitch, stick izquierdo X = roll.
  - Velocidades angulares con ease exponencial (`k=12`, 1.6 rad/s) y zona muerta 0.18: sin escalones. Clamp relativo 0.05x–8.0x heredado.
  - Orden de pads = enumeración del browser (pad[0] yaw+escala, pad[1] pitch+roll); verificar con `?debugpads=1` si se sienten invertidos.
- **B/Y dual: tap = reset, mantener 1.2s = salir de VR a la página 2D:**
  - La acción de tap se difiere al release: un hold nunca resetea antes de salir. Pulso a los 600ms ("seguí manteniendo") + buzz largo al salir.
  - `exitSession()` + `sessionend` robusto: limpia grabs fantasma, two-hand, recall, escala desktop y estados de botones (salir a mitad de un grab ya no deja estado corrupto).
- Guía del HUD actualizada. Un cursor (pan/órbita) y VR inmersivo sin cambios.

### [v1.6.0] - 2026-10-11
#### ✨ Paquete UX en VR: Highlight + Hápticos + Bring-To-Me + Reset en Mando
- **Highlight al apuntar:** el modelo brilla (pulso emisivo sky-blue) cuando un ray lo toca y glow fijo mientras se agarra; restaura el emisivo original al soltar. Materiales cacheados por carga (incluye multi-material, ignora básicos sin emissive).
- **Hápticos con significado (2 manos):** buzz al tocar los topes 0.05x/8.0x (cooldown 500ms) + vibración proporcional a la velocidad de escalado (cooldown 150ms). En ambos mandos.
- **Bring-to-me:** doble trigger al vacío trae el modelo a 0.6m frente al usuario (glide 0.35s easeOutCubic). Un grab real siempre gana (cancela el glide); no dispara si ya está agarrado. Paridad desktop: doble-click en vacío hace lo mismo.
- **Reset en B/Y (botones[5], cualquier mano):** restaura pose sin sacarse el visor (mismo `resetModelPose()` del botón HUD, ahora compartido) + pulso háptico.
- Núcleo VR intacto (grips, EMA, cascada, world-lock sin cambios). Guía del HUD actualizada.

### [v1.5.2] - 2026-10-11
#### ⚡ Menor Latencia en Escalado VR a 2 Manos
- **Causa del lag:** la cascada anti-escalones sumaba ~200ms (EMA α=0.15 + distancia k=10 + ratio k=8 + lerp final k=14 + slew 3.0/s que capaba gestos rápidos).
- **Reajuste (fluidez conservada, respuesta ~2.5× más rápida):**
  - EMA posiciones `0.15 → 0.45` (asienta en 1-2 frames; el ruido residual lo atrapan las etapas siguientes).
  - Distancia `k=10 → 25`, ratio `k=8 → 22`, lerp final `k=14 → 35`.
  - Slew limit `3.0 → 8.0` ratio/s: los piches rápidos ya no se capan; los picos siguen limitados.
  - Se mantienen freeze sub-perceptual (0.4mm) y clamp relativo 0.05x–8.0x: sin escalones.
- Posición/rotación intactas (`k=22`).

### [v1.5.1] - 2026-10-11
#### 🐛 Fix: Escala Rota según el Modelo Cargado (VR + PC)
- **Causa:** el clamp `0.05–8.0` se aplicaba sobre la escala **absoluta**, pero cada GLB normaliza a una escala absoluta distinta (casa grande ≈ 0.02, objeto chico ≈ 10+). Al agarrar para escalar, el clamp pisaba el valor: el modelo saltaba de tamaño y el rango quedaba descentrado/roto.
- **Solución (límites ahora relativos `0.05x–8.0x`, como documenta la tabla de controles):**
  - VR: `target = baseDelModelo × ratio` (el ratio ya venía clampeado) + guard anti-NaN.
  - PC/Gamepad: ratio clampeado plano `[0.05, 8.0]`, `s = base × ratio` + guard.
- **Estado limpio por modelo:** `normalizeAndDisplayModel` guarda la referencia `normalizedScale` (1.0x propio de cada modelo) y resetea targets de grab/escala pendientes, para que cada modelo cargado desde la UI escale sano desde su referencia.
- **Reset completo:** el botón Reset ahora restaura posición + rotación + escala normalizada.

### [v1.5.0] - 2026-10-11
#### 🖱️ Paridad Total Quest-2D = Mouse PC + Escala 2-Mandos sin VR (VR intacto)
- **PAN con UN solo botón de grab (botón 0 = click izq PC = trigger Quest):**
  - Se eliminó el grab con botón derecho: mantener el primario **sobre el modelo** = PAN 1:1 en plano facing-cámara; fuera del modelo = órbita OrbitControls. Idéntico en PC y browser 2D del Quest.
  - Intercepción en **fase capture sobre el contenedor padre** + `stopPropagation`: OrbitControls (registrado primero) ya no arranca un ROTATE fantasma al agarrar (antes dependíamos de un detalle de la v160).
  - `mouseButtons` de OrbitControls fijados explícitos (LEFT órbita / MIDDLE zoom / RIGHT pan).
  - Cierre de drag robusto: `pointerup` + `pointercancel` + `lostpointercapture` + `blur`; `setPointerCapture` en try/catch; guard anti-NaN; cursor `grabbing`.
  - Touch single-finger fluye por el mismo path (reporta botón 0); segundo dedo cede a OrbitControls.
- **Escala sin VR con 2 mandos (Gamepad API):**
  - Trigger o grip en **ambos** mandos = modo escala; thumbstick Y promediado (arriba = agrandar) con zona muerta 0.18, tasa 0.9 ratio/s, clamp 0.05–8 (mismo rango que VR).
  - Sin poses 6DoF fuera de XR: los sticks reemplazan la distancia entre manos; integración por `dt` = continuo, sin escalones. Inactivo silencioso sin gamepads (PC-mouse inalterado).
  - Overlay debug `?debugpads=1` con snapshot en vivo (ids, botones, ejes) para confirmar el mapeo real del Quest Browser.
- **VR inmersivo sin cambios** (grips, EMA, cascada de escala, world-lock intactos).

### [v1.4.0] - 2026-10-11
#### 🗜️ Soporte Draco + 📊 Loading UI 3D en Escena
- **Descompresión Draco (`DRACOLoader` 1.5.6):**
  - Decoder WASM desde CDN oficial Google (`gstatic.com/draco/versioned/decoders/1.5.6/gltf/`).
  - Acoplado al `GLTFLoader` vía `setDRACOLoader`: los `.glb`/`.gltf` comprimidos con Draco ahora cargan directo (modelos más livianos = descarga más rápida en el Quest).
- **Overlay de carga 3D world-locked (`LoadingUI3D`):**
  - Panel + barra de progreso (crece izq→der, sin z-fighting) + texto en canvas (nombre archivo + %).
  - Se posiciona frente a la cámara a 1.5m a altura de ojos y hace **yaw-billboard** cada frame (siempre legible, texto vertical).
  - `onProgress` real (`loaded/total`); si el total es desconocido muestra **pulso indeterminado** animado.
  - Ciclo de vida: aparece al iniciar, marca 100% y hace **fade-out** al completar; en error la barra pasa a **rojo** con el motivo y auto-oculta a los 5s.
  - Centralizado en `startGltfLoad()` con **token anti-carrera**: si el usuario cambia de modelo mid-download, los callbacks viejos se ignoran.
  - Vale para dropdown, archivo custom y carga inicial. `depthTest: false` + `renderOrder` alto: visible en VR void y passthrough.

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
