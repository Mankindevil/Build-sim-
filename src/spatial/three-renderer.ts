import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SpatialLayer, SpatialSceneModel, SpatialSceneNode } from "./model";
import type { SpatialSelectionController } from "./selection";
import type { SpatialOverlayModel } from "./overlays";

export interface ThreeSpatialOptions {
  host: HTMLElement;
  root: HTMLElement;
  model: SpatialSceneModel;
  overlays: SpatialOverlayModel;
  selection: SpatialSelectionController;
  onContextLost: () => void;
}

export interface ThreeSpatialRenderer {
  update(model: SpatialSceneModel, overlays: SpatialOverlayModel): void;
  focus(partId: string | null, frame?: boolean): void;
  setFinding(findingId: string | null, frame?: boolean): void;
  setRoutesVisible(visible: boolean): void;
  setDimensionsVisible(visible: boolean): void;
  setThermalVisible(visible: boolean): void;
  setAssemblyStep(index: number | null): void;
  capture(filename: string): void;
  getViewContext(): Record<string, unknown>;
  reset(): void;
  dispose(): void;
}

export const SPATIAL_DRAG_THRESHOLD_PX = 5;
const ORTHOGRAPHIC_HALF_HEIGHT = 260;
const CAMERA_FOV_DEG = 36;

export interface SpatialPointerPoint { x: number; y: number; }

export function exceedsSpatialDragThreshold(start: SpatialPointerPoint, current: SpatialPointerPoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > SPATIAL_DRAG_THRESHOLD_PX;
}

export function perspectiveVisibleHeight(distance: number, fovDeg = CAMERA_FOV_DEG): number {
  return 2 * Math.max(0, distance) * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
}

export function perspectiveDistanceForVisibleHeight(height: number, fovDeg = CAMERA_FOV_DEG): number {
  return Math.max(0, height) / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
}

export function orthographicZoomForVisibleHeight(height: number, frustumHeight = ORTHOGRAPHIC_HALF_HEIGHT * 2): number {
  return height > 0 ? frustumHeight / height : 1;
}

const COLORS: Record<string, number> = {
  shell: 0x91a4b7, interior: 0x6b7d90, chassis: 0x8391a1, deck: 0x667482,
  board: 0x2d9f74, cpu: 0xf0b34c, ram: 0x36a172, m2: 0x9b7be8, psu: 0x5197d5,
  cooler: 0x5ec3c9, radiator: 0x47a3aa, gpu: 0xbd6fe7, hba: 0xd474c6, drive: 0x4e8fcc,
  empty: 0x46515f, boot: 0x8b70dc, fan: 0x55c8b1, pcb: 0x3c9c69, connector: 0xe79055,
  reserve: 0xc6a94a, clearance: 0xe1a83e, conflict: 0xef4c5b, usb: 0x9b7be8,
};
const LAYERS: SpatialLayer[] = ["shell", "structure", "components", "storage", "airflow", "clearance", "conflicts"];
const LAYER_LABELS: Record<SpatialLayer, string> = {
  shell: "机箱外壳",
  structure: "内部结构",
  components: "核心部件",
  storage: "存储设备",
  airflow: "风扇与风道",
  clearance: "净空与预留",
  conflicts: "冲突区域",
};

type CameraMode = "perspective" | "orthographic";
type SpatialViewName = "iso" | "front" | "side" | "top";
interface PickRecord { object: THREE.Object3D; nodes: SpatialSceneNode[]; }
interface PickHit { node: SpatialSceneNode; object: THREE.Object3D; instanceId: number | null; }

function materialFor(node: SpatialSceneNode): THREE.MeshStandardMaterial {
  const transparent = node.layer === "shell" || node.layer === "clearance" || node.kind === "empty";
  return new THREE.MeshStandardMaterial({
    color: COLORS[node.kind] ?? 0x8796a5,
    transparent,
    opacity: node.kind === "shell" ? 0.12 : node.kind === "interior" ? 0.025 : node.kind === "empty" ? 0.08 : node.layer === "clearance" ? 0.14 : 0.82,
    depthWrite: !transparent,
    roughness: 0.72,
    metalness: ["chassis", "shell", "psu", "drive"].includes(node.kind) ? 0.35 : 0.08,
    wireframe: node.kind === "interior" || node.kind === "clearance" || node.kind === "reserve",
    side: node.kind === "shell" ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function explodedCenter(node: SpatialSceneNode, explode: boolean): THREE.Vector3 {
  const distance = explode && node.layer !== "shell" ? 38 : 0;
  return new THREE.Vector3(
    node.box.c[0] + node.explodedOffset[0] * distance,
    node.box.c[1] + node.explodedOffset[1] * distance,
    node.box.c[2] + node.explodedOffset[2] * distance,
  );
}

function setTransform(object: THREE.Object3D, node: SpatialSceneNode, explode: boolean): void {
  object.position.copy(explodedCenter(node, explode));
  object.rotation.set(node.rotation[0], node.rotation[1], node.rotation[2]);
  object.scale.set(node.box.w, node.box.h, node.box.d);
}

function groupKey(node: SpatialSceneNode): string {
  return node.repeatGroup ? `${node.repeatGroup}:${node.box.w}:${node.box.h}:${node.box.d}:${node.layer}` : node.id;
}

export function createThreeSpatialRenderer(options: ThreeSpatialOptions): ThreeSpatialRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "可交互机箱 3D 场景；拖动旋转，右键平移，滚轮缩放，点击选择部件，Esc 清空选择");
  options.host.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const ambient = new THREE.HemisphereLight(0xcde3ff, 0x1b2430, 2.2);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(-260, 400, -300); scene.add(key);
  const fill = new THREE.DirectionalLight(0x7ab4ff, 1.1); fill.position.set(280, 120, 260); scene.add(fill);
  const rootGroup = new THREE.Group(); scene.add(rootGroup);
  const routeGroup = new THREE.Group(); scene.add(routeGroup);
  const dimensionGroup = new THREE.Group(); scene.add(dimensionGroup);
  const thermalGroup = new THREE.Group(); scene.add(thermalGroup);
  const grid = new THREE.GridHelper(620, 20, 0x607080, 0x344252); grid.position.y = -164; scene.add(grid);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickRecords = new Map<string, PickRecord>();
  const visibleLayers = new Set<SpatialLayer>(LAYERS);
  const listenerAbort = new AbortController();
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let model = options.model;
  let overlays = options.overlays;
  let cameraMode: CameraMode = "perspective";
  let activeView: SpatialViewName | null = "iso";
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  let controls: OrbitControls;
  let explode = false;
  let routesVisible = false;
  let dimensionsVisible = false;
  let thermalVisible = false;
  let activeFindingId: string | null = null;
  let assemblyStepIndex: number | null = null;
  let hoveredPartId: string | null = null;
  let selectedPartId: string | null = options.selection.getState().selectedPartId;
  let hovered: { object: THREE.Object3D; instanceId: number | null } | null = null;
  let selected: { object: THREE.Object3D; instanceId: number | null } | null = null;
  let pointerDown: { pointerId: number; start: SpatialPointerPoint; moved: boolean } | null = null;
  let suppressNextClick = false;
  let pendingHoverPoint: SpatialPointerPoint | null = null;
  let disposed = false;
  let controlsActive = false;
  let frameHandle: number | null = null;
  let needsRender = false;
  let sceneRevision = 0;
  let renderFrameCount = 0;

  const aspect = () => Math.max(1, options.host.clientWidth) / Math.max(1, options.host.clientHeight);
  const makeCamera = () => cameraMode === "perspective"
    ? new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect(), 1, 3000)
    : new THREE.OrthographicCamera(-ORTHOGRAPHIC_HALF_HEIGHT * aspect(), ORTHOGRAPHIC_HALF_HEIGHT * aspect(), ORTHOGRAPHIC_HALF_HEIGHT, -ORTHOGRAPHIC_HALF_HEIGHT, 1, 3000);
  camera = makeCamera();
  controls = undefined as unknown as OrbitControls;

  const renderNow = () => {
    if (disposed) return;
    renderer.render(scene, camera);
    renderFrameCount += 1;
  };
  const scheduleFrame = () => {
    if (disposed || frameHandle !== null) return;
    frameHandle = requestAnimationFrame(runFrame);
  };
  const invalidate = () => {
    needsRender = true;
    scheduleFrame();
  };
  const processPendingHover = () => {
    if (!pendingHoverPoint || controlsActive || pointerDown?.moved) return;
    const point = pendingHoverPoint;
    pendingHoverPoint = null;
    const hit = nodeAtPoint(point);
    const nextPartId = hit?.node.partId ?? null;
    if (nextPartId === hoveredPartId) return;
    hoveredPartId = nextPartId;
    hovered = hit ? { object: hit.object, instanceId: hit.instanceId } : null;
    options.selection.hover(nextPartId);
    renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    recolor();
  };
  function runFrame(): void {
    frameHandle = null;
    if (disposed) return;
    const controlsChanged = Boolean(controls?.enableDamping && controls.update());
    processPendingHover();
    if (needsRender || controlsChanged) renderNow();
    needsRender = false;
    if (controlsActive || controlsChanged || pendingHoverPoint) scheduleFrame();
  }

  const disposeMaterial = (material: THREE.Material | THREE.Material[] | undefined) => {
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  };
  const disposeGroup = (group: THREE.Group) => {
    while (group.children.length) {
      const object = group.children[0]!;
      group.remove(object);
      object.traverse((child) => {
        const drawable = child as THREE.Mesh | THREE.Line;
        drawable.geometry?.dispose();
        disposeMaterial(drawable.material);
      });
    }
  };

  const lineObject = (points: [number, number, number][], color: number, dashed = false) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(point[0], point[1], point[2])));
    const material = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 8, gapSize: 5, transparent: true, opacity: 0.86 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geometry, material);
    if (dashed) line.computeLineDistances();
    return line;
  };

  const rebuildOverlays = () => {
    disposeGroup(routeGroup); disposeGroup(dimensionGroup); disposeGroup(thermalGroup);
    for (const route of overlays.routes) {
      const color = route.verdict === "bad" ? 0xef4c5b : route.verdict === "warn" ? 0xe4a53e : route.kind === "power" ? 0xf06d6d : 0x4f9ee8;
      if (route.toleranceMm !== null && route.toleranceMm > 0 && route.points.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(route.points.map((point) => new THREE.Vector3(...point)), false, "centripetal");
        const band = new THREE.Mesh(
          new THREE.TubeGeometry(curve, Math.max(2, route.points.length * 6), route.toleranceMm, 8, false),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, depthWrite: false }),
        );
        band.name = `tolerance:${route.id}`;
        band.userData.routeId = route.id;
        routeGroup.add(band);
      }
      const line = lineObject(route.points, color, !route.pathAvailable || route.evidence === "unknown");
      line.name = route.id; line.userData.routeId = route.id; routeGroup.add(line);
      for (const [index, alternative] of route.alternativePaths.entries()) {
        const alternativeLine = lineObject(alternative, 0x8b97a5, true);
        alternativeLine.name = `alternative:${route.id}:${index}`;
        alternativeLine.userData.routeId = route.id;
        routeGroup.add(alternativeLine);
      }
      for (const [index, marker] of route.endpointDirections.entries()) {
        const direction = new THREE.Vector3(...marker.direction);
        if (direction.lengthSq() <= 0.000001) continue;
        const arrow = new THREE.ArrowHelper(direction.normalize(), new THREE.Vector3(...marker.at), 20, color, 7, 4);
        arrow.name = `direction:${route.id}:${index}`;
        arrow.userData.routeId = route.id;
        routeGroup.add(arrow);
      }
      for (const [index, point] of route.blockedPoints.entries()) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(5, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xef4c5b, transparent: true, opacity: 0.9 }),
        );
        marker.position.set(...point);
        marker.name = `blocked:${route.id}:${index}`;
        marker.userData.routeId = route.id;
        routeGroup.add(marker);
      }
    }
    for (const dimension of overlays.dimensions) {
      const color = dimension.evidence === "official" ? 0x4f9ee8 : dimension.evidence === "standard" ? 0x42b88d : dimension.evidence === "inferred" ? 0xe4a53e : 0x8b97a5;
      const line = lineObject([dimension.from, dimension.to], color, dimension.evidence !== "official");
      line.name = dimension.id; line.userData.label = dimension.label; dimensionGroup.add(line);
    }
    for (const source of overlays.thermal.sources) {
      const normalized = THREE.MathUtils.clamp((source.tempC.hi - 25) / 65, 0, 1);
      const color = new THREE.Color(0x3d8be8).lerp(new THREE.Color(0xef4c5b), normalized);
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false, wireframe: true });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), material);
      mesh.position.set(source.at[0], source.at[1], source.at[2]);
      mesh.scale.set(source.sigmaMm[0], source.sigmaMm[1], source.sigmaMm[2]);
      mesh.name = `heat:${source.id}`; mesh.userData.note = overlays.thermal.note; thermalGroup.add(mesh);
    }
    for (const fan of model.nodes.filter((node) => node.kind === "fan")) {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...fan.box.c), 52, 0x55c8b1, 12, 7);
      arrow.name = `airflow:${fan.partId}`; thermalGroup.add(arrow);
    }
    routeGroup.visible = routesVisible;
    dimensionGroup.visible = dimensionsVisible;
    thermalGroup.visible = thermalVisible && overlays.thermal.available;
  };

  const updateInstanceMatrices = (mesh: THREE.InstancedMesh, nodes: SpatialSceneNode[]) => {
    const dummy = new THREE.Object3D();
    nodes.forEach((node, index) => {
      setTransform(dummy, node, explode); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  const pickForPart = (partId: string | null) => {
    if (!partId) return null;
    for (const record of pickRecords.values()) {
      const index = record.nodes.findIndex((node) => node.partId === partId);
      if (index >= 0) return { object: record.object, instanceId: record.object instanceof THREE.InstancedMesh ? index : null };
    }
    return null;
  };

  const rebuild = () => {
    pickRecords.clear(); hovered = null; selected = null;
    disposeGroup(rootGroup);
    const groups = new Map<string, SpatialSceneNode[]>();
    model.nodes.filter((node) => visibleLayers.has(node.layer)).forEach((node) => {
      const keyName = groupKey(node); const current = groups.get(keyName) ?? []; current.push(node); groups.set(keyName, current);
    });
    for (const nodes of groups.values()) {
      const first = nodes[0]!;
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      if (first.repeatGroup && nodes.length > 1) {
        const mesh = new THREE.InstancedMesh(geometry, materialFor(first), nodes.length);
        updateInstanceMatrices(mesh, nodes); mesh.name = `instances:${first.repeatGroup}`;
        rootGroup.add(mesh); pickRecords.set(mesh.uuid, { object: mesh, nodes });
      } else {
        const mesh = new THREE.Mesh(geometry, materialFor(first)); setTransform(mesh, first, explode); mesh.name = first.partId;
        rootGroup.add(mesh); pickRecords.set(mesh.uuid, { object: mesh, nodes });
      }
    }
    selected = pickForPart(selectedPartId);
    hovered = pickForPart(hoveredPartId);
    rebuildOverlays();
    sceneRevision += 1;
    recolor();
  };

  const updateTransforms = () => {
    for (const record of pickRecords.values()) {
      if (record.object instanceof THREE.InstancedMesh) updateInstanceMatrices(record.object, record.nodes);
      else setTransform(record.object, record.nodes[0]!, explode);
    }
    invalidate();
  };

  function nodeAtPoint(point: SpatialPointerPoint): PickHit | null {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.set(((point.x - rect.left) / rect.width) * 2 - 1, -((point.y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(rootGroup.children, false).find((candidate) => {
      const record = pickRecords.get(candidate.object.uuid);
      const node = record?.nodes[candidate.instanceId ?? 0];
      return node?.selectable;
    });
    if (!hit) return null;
    const record = pickRecords.get(hit.object.uuid)!;
    return { node: record.nodes[hit.instanceId ?? 0]!, object: hit.object, instanceId: hit.instanceId ?? null };
  }

  function recolor(): void {
    const finding = overlays.findings.find((item) => item.id === activeFindingId);
    const findingParts = new Set(finding?.partIds ?? []);
    const findingColor = finding?.verdict === "warn" ? 0xe4a53e : 0xef4c5b;
    const findingEmissive = finding?.verdict === "warn" ? 0x654200 : 0x6f1017;
    const assemblyParts = assemblyStepIndex === null ? null : new Set(overlays.assembly[assemblyStepIndex]?.partIds ?? []);
    const color = new THREE.Color();
    for (const record of pickRecords.values()) {
      const mesh = record.object as THREE.Mesh | THREE.InstancedMesh;
      if (mesh instanceof THREE.InstancedMesh) {
        record.nodes.forEach((node, index) => {
          const active = (selected?.object === mesh && selected.instanceId === index) || (hovered?.object === mesh && hovered.instanceId === index) || findingParts.has(node.partId) || assemblyParts?.has(node.partId);
          color.set(active ? findingParts.has(node.partId) ? findingColor : 0xffd166 : COLORS[node.kind] ?? 0x8796a5);
          if (assemblyParts && !assemblyParts.has(node.partId)) color.multiplyScalar(0.18);
          mesh.setColorAt(index, color);
        });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      } else {
        const material = mesh.material as THREE.MeshStandardMaterial;
        const node = record.nodes[0]!;
        const emphasized = selected?.object === mesh || hovered?.object === mesh || findingParts.has(node.partId) || assemblyParts?.has(node.partId);
        material.emissive.set(findingParts.has(node.partId) ? findingEmissive : emphasized ? 0x5f4200 : 0x000000);
        material.color.set(COLORS[node.kind] ?? 0x8796a5);
        const baseTransparent = node.layer === "shell" || node.layer === "clearance" || node.kind === "empty";
        const baseOpacity = node.kind === "shell" ? 0.12 : node.kind === "interior" ? 0.025 : node.kind === "empty" ? 0.08 : node.layer === "clearance" ? 0.14 : 0.82;
        material.transparent = baseTransparent || Boolean(assemblyParts);
        material.opacity = assemblyParts && node.layer !== "shell" && !assemblyParts.has(node.partId) ? 0.08 : baseOpacity;
        material.depthWrite = !material.transparent;
      }
    }
    invalidate();
  }

  const setViewButtons = (view: SpatialViewName | null) => {
    activeView = view;
    options.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
  };
  const setCameraButtons = () => {
    options.root.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.camera === cameraMode)));
  };
  const cameraDirection = () => {
    const direction = camera.position.clone().sub(controls.target);
    return direction.lengthSq() > 0.0001 ? direction.normalize() : new THREE.Vector3(0.62, 0.47, -0.67).normalize();
  };
  const frameBox = (box: SpatialSceneNode["box"], direction = cameraDirection()) => {
    const target = new THREE.Vector3(...box.c);
    const radius = Math.max(1, Math.hypot(box.w, box.h, box.d) / 2);
    if (camera instanceof THREE.PerspectiveCamera) {
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      const distance = THREE.MathUtils.clamp(radius * 1.3 / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)), controls.minDistance, controls.maxDistance);
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.zoom = 1;
    } else {
      const verticalZoom = ORTHOGRAPHIC_HALF_HEIGHT / (radius * 1.3);
      const horizontalZoom = ORTHOGRAPHIC_HALF_HEIGHT * aspect() / (radius * 1.3);
      camera.zoom = THREE.MathUtils.clamp(Math.min(verticalZoom, horizontalZoom), controls.minZoom, controls.maxZoom);
      const distance = Math.max(camera.position.distanceTo(controls.target), radius * 2.8, 240);
      camera.position.copy(target).addScaledVector(direction, distance);
    }
    controls.target.copy(target);
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  };
  const framePart = (partId: string) => {
    const node = model.nodes.find((item) => item.partId === partId);
    if (!node) return;
    const box = { ...node.box, c: explodedCenter(node, explode).toArray() as [number, number, number] };
    frameBox(box);
  };
  const setView = (view: SpatialViewName) => {
    const directions: Record<SpatialViewName, THREE.Vector3> = {
      iso: new THREE.Vector3(0.62, 0.47, -0.67).normalize(),
      front: new THREE.Vector3(0, 0, -1),
      side: new THREE.Vector3(1, 0, 0),
      top: new THREE.Vector3(0, 1, 0.001).normalize(),
    };
    camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
    frameBox(model.bounds, directions[view]);
    setViewButtons(view);
  };

  const visibleHeight = () => camera instanceof THREE.PerspectiveCamera
    ? perspectiveVisibleHeight(camera.position.distanceTo(controls.target), camera.fov) / camera.zoom
    : (camera.top - camera.bottom) / camera.zoom;
  const removeControlListeners = () => {
    if (!controls) return;
    controls.removeEventListener("start", onControlStart);
    controls.removeEventListener("end", onControlEnd);
    controls.removeEventListener("change", onControlChange);
    controls.dispose();
  };
  const installControls = (target = new THREE.Vector3()) => {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 24;
    controls.maxDistance = 2400;
    controls.minZoom = 0.25;
    controls.maxZoom = 12;
    controls.target.copy(target);
    controls.listenToKeyEvents(renderer.domElement);
    controls.addEventListener("start", onControlStart);
    controls.addEventListener("end", onControlEnd);
    controls.addEventListener("change", onControlChange);
    controls.update();
    // OrbitControls writes an inline `none`; allow the responsive stylesheet to choose pan-y on mobile.
    renderer.domElement.style.removeProperty("touch-action");
  };
  const switchCamera = (nextMode: CameraMode) => {
    if (nextMode === cameraMode) return;
    const target = controls.target.clone();
    const direction = cameraDirection();
    const height = visibleHeight();
    const position = camera.position.clone();
    const up = camera.up.clone();
    removeControlListeners();
    cameraMode = nextMode;
    camera = makeCamera();
    camera.up.copy(up);
    if (camera instanceof THREE.OrthographicCamera) {
      camera.position.copy(position);
      camera.zoom = THREE.MathUtils.clamp(orthographicZoomForVisibleHeight(height), 0.25, 12);
    } else {
      const distance = THREE.MathUtils.clamp(perspectiveDistanceForVisibleHeight(height, camera.fov), 24, 2400);
      camera.position.copy(target).addScaledVector(direction, distance);
    }
    camera.updateProjectionMatrix();
    installControls(target);
    setCameraButtons();
    resize();
  };

  function onControlStart(): void {
    controlsActive = true;
    setViewButtons(null);
    renderer.domElement.style.cursor = "grabbing";
    scheduleFrame();
  }
  function onControlEnd(): void {
    controlsActive = false;
    renderer.domElement.style.cursor = hoveredPartId ? "pointer" : "grab";
    scheduleFrame();
  }
  function onControlChange(): void {
    invalidate();
  }

  const onPointerDown = (event: PointerEvent) => {
    renderer.domElement.focus({ preventScroll: true });
    if (event.button !== 0) return;
    pointerDown = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false };
    suppressNextClick = false;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (pointerDown?.pointerId === event.pointerId && !pointerDown.moved) {
      pointerDown.moved = exceedsSpatialDragThreshold(pointerDown.start, { x: event.clientX, y: event.clientY });
      if (pointerDown.moved) {
        pendingHoverPoint = null;
        hoveredPartId = null;
        hovered = null;
        options.selection.hover(null);
        recolor();
      }
    }
    if (!controlsActive && !pointerDown?.moved) {
      pendingHoverPoint = { x: event.clientX, y: event.clientY };
      scheduleFrame();
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    if (pointerDown?.pointerId !== event.pointerId) return;
    suppressNextClick = pointerDown.moved;
    pointerDown = null;
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (pointerDown?.pointerId !== event.pointerId) return;
    suppressNextClick = pointerDown.moved;
    pointerDown = null;
  };
  const onPointerLeave = () => {
    if (pointerDown) return;
    pendingHoverPoint = null;
    if (!hoveredPartId) return;
    hoveredPartId = null;
    hovered = null;
    options.selection.hover(null);
    renderer.domElement.style.cursor = "grab";
    recolor();
  };
  const onClick = (event: MouseEvent) => {
    if (suppressNextClick) { suppressNextClick = false; return; }
    const hit = nodeAtPoint({ x: event.clientX, y: event.clientY });
    activeFindingId = null;
    selectedPartId = hit?.node.partId ?? null;
    selected = hit ? { object: hit.object, instanceId: hit.instanceId } : null;
    options.selection.select(selectedPartId);
    recolor();
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (nodeAtPoint({ x: event.clientX, y: event.clientY })) return;
    setView("iso");
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    activeFindingId = null;
    selectedPartId = null;
    selected = null;
    options.selection.select(null);
    recolor();
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    options.onContextLost();
  };

  renderer.domElement.addEventListener("pointerdown", onPointerDown, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("pointermove", onPointerMove, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("pointerup", onPointerUp, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("pointercancel", onPointerCancel, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("pointerleave", onPointerLeave, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("click", onClick, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("dblclick", onDoubleClick, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("keydown", onKeyDown, { signal: listenerAbort.signal });
  renderer.domElement.addEventListener("webglcontextlost", onContextLost, { once: true, signal: listenerAbort.signal });

  function resize(): void {
    const width = Math.max(1, options.host.clientWidth); const height = Math.max(1, options.host.clientHeight);
    renderer.setSize(width, height, false);
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = width / height;
    else { camera.left = -ORTHOGRAPHIC_HALF_HEIGHT * width / height; camera.right = ORTHOGRAPHIC_HALF_HEIGHT * width / height; }
    camera.updateProjectionMatrix();
    invalidate();
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(options.host);

  options.root.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((button) => button.addEventListener("click", () => switchCamera(button.dataset.camera as CameraMode), { signal: listenerAbort.signal }));
  options.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view as SpatialViewName), { signal: listenerAbort.signal }));
  options.root.querySelector<HTMLButtonElement>("[data-reset]")?.addEventListener("click", () => setView("iso"), { signal: listenerAbort.signal });
  options.root.querySelector<HTMLInputElement>("[data-explode]")?.addEventListener("change", (event) => {
    explode = (event.target as HTMLInputElement).checked;
    updateTransforms();
    if (selectedPartId) framePart(selectedPartId);
  }, { signal: listenerAbort.signal });
  const layerControls = options.root.querySelector<HTMLElement>("[data-layer-controls]")!;
  for (const layer of LAYERS) {
    const label = document.createElement("label"); const input = document.createElement("input");
    input.type = "checkbox"; input.checked = true; input.dataset.layer = layer;
    input.addEventListener("change", () => {
      if (input.checked) visibleLayers.add(layer); else visibleLayers.delete(layer);
      rebuild();
    }, { signal: listenerAbort.signal });
    label.append(input, ` ${LAYER_LABELS[layer]}`); layerControls.append(label);
  }

  installControls();
  resize();
  rebuild();
  setView("iso");
  setCameraButtons();

  const focus = (partId: string | null, frame = true) => {
    const node = partId ? model.nodes.find((item) => item.partId === partId) : null;
    if (node && !visibleLayers.has(node.layer)) {
      visibleLayers.add(node.layer);
      const input = options.root.querySelector<HTMLInputElement>(`[data-layer="${node.layer}"]`);
      if (input) input.checked = true;
      rebuild();
    }
    selectedPartId = node?.partId ?? null;
    selected = pickForPart(selectedPartId);
    if (node && frame) { setViewButtons(null); framePart(node.partId); }
    recolor();
  };

  return {
    update(nextModel, nextOverlays) {
      model = nextModel;
      overlays = nextOverlays;
      if (activeFindingId && !overlays.findings.some((finding) => finding.id === activeFindingId)) activeFindingId = null;
      if (assemblyStepIndex !== null && !overlays.assembly[assemblyStepIndex]) assemblyStepIndex = null;
      if (selectedPartId && !model.nodes.some((node) => node.partId === selectedPartId)) selectedPartId = null;
      if (hoveredPartId && !model.nodes.some((node) => node.partId === hoveredPartId)) hoveredPartId = null;
      rebuild();
    },
    focus,
    setFinding(findingId, frame = true) {
      const normalized = findingId && overlays.findings.some((finding) => finding.id === findingId) ? findingId : null;
      const changed = normalized !== activeFindingId;
      activeFindingId = normalized;
      const partId = normalized ? overlays.findings.find((finding) => finding.id === normalized)?.partIds[0] ?? null : null;
      if (frame && partId) { setViewButtons(null); framePart(partId); }
      if (changed || frame) recolor();
    },
    setRoutesVisible(visible) {
      if (routesVisible === visible) return;
      routesVisible = visible; routeGroup.visible = visible; invalidate();
    },
    setDimensionsVisible(visible) {
      if (dimensionsVisible === visible) return;
      dimensionsVisible = visible; dimensionGroup.visible = visible; invalidate();
    },
    setThermalVisible(visible) {
      if (thermalVisible === visible) return;
      thermalVisible = visible; thermalGroup.visible = visible && overlays.thermal.available; invalidate();
    },
    setAssemblyStep(index) {
      const normalized = index !== null && Number.isInteger(index) && index >= 0 && index < overlays.assembly.length ? index : null;
      if (assemblyStepIndex === normalized) return;
      assemblyStepIndex = normalized; recolor();
    },
    capture(filename) {
      controls.update(); renderNow();
      renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      }, "image/png");
    },
    getViewContext() {
      return {
        cameraMode,
        activeView,
        cameraPositionMm: camera.position.toArray(),
        cameraUp: camera.up.toArray(),
        targetMm: controls.target.toArray(),
        visibleHeightMm: visibleHeight(),
        explode,
        routesVisible,
        dimensionsVisible,
        thermalVisible,
        activeFindingId,
        selectedPartId,
        assemblyStepId: assemblyStepIndex === null ? null : overlays.assembly[assemblyStepIndex]?.id ?? null,
        sceneRevision,
        renderFrameCount,
      };
    },
    reset() { setView("iso"); },
    dispose() {
      if (disposed) return;
      disposed = true;
      listenerAbort.abort();
      resizeObserver.disconnect();
      removeControlListeners();
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      frameHandle = null;
      disposeGroup(rootGroup); disposeGroup(routeGroup); disposeGroup(dimensionGroup); disposeGroup(thermalGroup);
      grid.geometry.dispose(); disposeMaterial(grid.material);
      renderer.dispose();
      options.host.replaceChildren();
    },
  };
}
