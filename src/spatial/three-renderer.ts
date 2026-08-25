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
  focus(partId: string | null): void;
  setFinding(findingId: string | null): void;
  setRoutesVisible(visible: boolean): void;
  setDimensionsVisible(visible: boolean): void;
  setThermalVisible(visible: boolean): void;
  setAssemblyStep(index: number | null): void;
  capture(filename: string): void;
  getViewContext(): Record<string, unknown>;
  reset(): void;
  dispose(): void;
}

const COLORS: Record<string, number> = {
  shell: 0x91a4b7, interior: 0x6b7d90, chassis: 0x8391a1, deck: 0x667482,
  board: 0x2d9f74, cpu: 0xf0b34c, ram: 0x36a172, m2: 0x9b7be8, psu: 0x5197d5,
  cooler: 0x5ec3c9, radiator: 0x47a3aa, gpu: 0xbd6fe7, hba: 0xd474c6, drive: 0x4e8fcc,
  empty: 0x46515f, boot: 0x8b70dc, fan: 0x55c8b1, pcb: 0x3c9c69, connector: 0xe79055,
  reserve: 0xc6a94a, clearance: 0xe1a83e, conflict: 0xef4c5b, usb: 0x9b7be8,
};
const LAYERS: SpatialLayer[] = ["shell", "structure", "components", "storage", "airflow", "clearance", "conflicts"];

interface PickRecord { object: THREE.Object3D; nodes: SpatialSceneNode[]; }

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

function setTransform(object: THREE.Object3D, node: SpatialSceneNode, explode: boolean): void {
  const distance = explode && node.layer !== "shell" ? 38 : 0;
  object.position.set(
    node.box.c[0] + node.explodedOffset[0] * distance,
    node.box.c[1] + node.explodedOffset[1] * distance,
    node.box.c[2] + node.explodedOffset[2] * distance,
  );
  object.rotation.set(node.rotation[0], node.rotation[1], node.rotation[2]);
  object.scale.set(node.box.w, node.box.h, node.box.d);
}

function groupKey(node: SpatialSceneNode): string {
  return node.repeatGroup ? `${node.repeatGroup}:${node.box.w}:${node.box.h}:${node.box.d}:${node.layer}` : node.id;
}

export function createThreeSpatialRenderer(options: ThreeSpatialOptions): ThreeSpatialRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "可交互 N6 3D 场景；拖动旋转，右键平移，滚轮缩放，点击选择部件");
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
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let model = options.model;
  let overlays = options.overlays;
  let cameraMode: "perspective" | "orthographic" = "perspective";
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  let controls: OrbitControls;
  let explode = false;
  let routesVisible = false;
  let dimensionsVisible = false;
  let thermalVisible = false;
  let activeFindingId: string | null = null;
  let assemblyStepIndex: number | null = null;
  let hovered: { object: THREE.Object3D; instanceId: number | null } | null = null;
  let selected: { object: THREE.Object3D; instanceId: number | null } | null = null;
  let disposed = false;

  const aspect = () => Math.max(1, options.host.clientWidth) / Math.max(1, options.host.clientHeight);
  const makeCamera = () => cameraMode === "perspective"
    ? new THREE.PerspectiveCamera(36, aspect(), 1, 2400)
    : new THREE.OrthographicCamera(-260 * aspect(), 260 * aspect(), 260, -260, 1, 2400);
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  const installControls = () => {
    controls?.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 160;
    controls.maxDistance = 1500;
    controls.addEventListener("change", render);
  };
  camera = makeCamera();
  controls = undefined as unknown as OrbitControls;
  installControls();

  const setView = (view: "iso" | "front" | "side" | "top") => {
    const positions = { iso: [480, 360, -520], front: [0, 0, -720], side: [720, 0, 0], top: [0, 760, 0.001] } as const;
    const position = positions[view];
    camera.position.set(position[0], position[1], position[2]);
    camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
    controls.target.set(0, 0, 0);
    controls.update(); render();
  };

  const updateInstanceMatrices = (mesh: THREE.InstancedMesh, nodes: SpatialSceneNode[]) => {
    const dummy = new THREE.Object3D();
    nodes.forEach((node, index) => {
      setTransform(dummy, node, explode); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  const disposeGroup = (group: THREE.Group) => {
    while (group.children.length) {
      const object = group.children[0]!;
      group.remove(object);
      object.traverse((child) => {
        const drawable = child as THREE.Mesh | THREE.Line;
        drawable.geometry?.dispose();
        const material = drawable.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material?.dispose();
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
      const line = lineObject(route.points, color, !route.pathAvailable || route.evidence === "unknown");
      line.name = route.id; line.userData.routeId = route.id; routeGroup.add(line);
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

  const rebuild = () => {
    pickRecords.clear(); hovered = null; selected = null;
    disposeGroup(rootGroup);
    const groups = new Map<string, SpatialSceneNode[]>();
    model.nodes.filter((node) => visibleLayers.has(node.layer)).forEach((node) => {
      const key = groupKey(node); const current = groups.get(key) ?? []; current.push(node); groups.set(key, current);
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
    rebuildOverlays(); recolor();
  };

  const nodeAt = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(rootGroup.children, false).find((candidate) => {
      const record = pickRecords.get(candidate.object.uuid);
      const node = record?.nodes[candidate.instanceId ?? 0];
      return node?.selectable;
    });
    if (!hit) return null;
    const record = pickRecords.get(hit.object.uuid)!;
    return { node: record.nodes[hit.instanceId ?? 0]!, object: hit.object, instanceId: hit.instanceId ?? null };
  };

  const recolor = () => {
    const findingParts = new Set(overlays.findings.find((finding) => finding.id === activeFindingId)?.partIds ?? []);
    const assemblyParts = assemblyStepIndex === null ? null : new Set(overlays.assembly[assemblyStepIndex]?.partIds ?? []);
    for (const record of pickRecords.values()) {
      const mesh = record.object as THREE.Mesh | THREE.InstancedMesh;
      if (mesh instanceof THREE.InstancedMesh) {
        record.nodes.forEach((node, index) => {
          const active = (selected?.object === mesh && selected.instanceId === index) || (hovered?.object === mesh && hovered.instanceId === index) || findingParts.has(node.partId) || assemblyParts?.has(node.partId);
          const color = new THREE.Color(active ? findingParts.has(node.partId) ? 0xef4c5b : 0xffd166 : COLORS[node.kind] ?? 0x8796a5);
          if (assemblyParts && !assemblyParts.has(node.partId)) color.multiplyScalar(0.18);
          mesh.setColorAt(index, color);
        });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      } else {
        const material = mesh.material as THREE.MeshStandardMaterial;
        const node = record.nodes[0]!;
        const emphasized = selected?.object === mesh || hovered?.object === mesh || findingParts.has(node.partId) || assemblyParts?.has(node.partId);
        material.emissive.set(findingParts.has(node.partId) ? 0x6f1017 : emphasized ? 0x5f4200 : 0x000000);
        material.color.set(COLORS[node.kind] ?? 0x8796a5);
        const baseTransparent = node.layer === "shell" || node.layer === "clearance" || node.kind === "empty";
        const baseOpacity = node.kind === "shell" ? 0.12 : node.kind === "interior" ? 0.025 : node.kind === "empty" ? 0.08 : node.layer === "clearance" ? 0.14 : 0.82;
        material.transparent = baseTransparent || Boolean(assemblyParts);
        material.opacity = assemblyParts && node.layer !== "shell" && !assemblyParts.has(node.partId) ? 0.08 : baseOpacity;
        material.depthWrite = !material.transparent;
      }
    }
    render();
  };

  const onMove = (event: PointerEvent) => {
    const hit = nodeAt(event);
    hovered = hit ? { object: hit.object, instanceId: hit.instanceId } : null;
    options.selection.hover(hit?.node.partId ?? null);
    renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    recolor();
  };
  const onClick = (event: PointerEvent) => {
    const hit = nodeAt(event);
    selected = hit ? { object: hit.object, instanceId: hit.instanceId } : null;
    options.selection.select(hit?.node.partId ?? null); recolor();
  };
  const focus = (partId: string | null) => {
    selected = null;
    if (partId) {
      for (const record of pickRecords.values()) {
        const index = record.nodes.findIndex((node) => node.partId === partId);
        if (index >= 0) { selected = { object: record.object, instanceId: record.object instanceof THREE.InstancedMesh ? index : null }; break; }
      }
    }
    recolor();
  };
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("click", onClick);
  renderer.domElement.addEventListener("webglcontextlost", (event) => { event.preventDefault(); options.onContextLost(); }, { once: true });

  const resize = () => {
    const width = Math.max(1, options.host.clientWidth); const height = Math.max(1, options.host.clientHeight);
    renderer.setSize(width, height, false);
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = width / height;
    else { camera.left = -260 * width / height; camera.right = 260 * width / height; }
    camera.updateProjectionMatrix(); render();
  };
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(options.host);

  options.root.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((button) => button.addEventListener("click", () => {
    cameraMode = button.dataset.camera as typeof cameraMode;
    const position = camera.position.clone(); camera = makeCamera(); camera.position.copy(position);
    installControls(); options.root.querySelectorAll("[data-camera]").forEach((item) => item.setAttribute("aria-pressed", String(item === button))); resize();
  }));
  options.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view as "iso" | "front" | "side" | "top")));
  options.root.querySelector<HTMLButtonElement>("[data-reset]")?.addEventListener("click", () => setView("iso"));
  options.root.querySelector<HTMLInputElement>("[data-explode]")?.addEventListener("change", (event) => { explode = (event.target as HTMLInputElement).checked; rebuild(); });
  const layerControls = options.root.querySelector<HTMLElement>("[data-layer-controls]")!;
  for (const layer of LAYERS) {
    const label = document.createElement("label"); const input = document.createElement("input");
    input.type = "checkbox"; input.checked = true; input.dataset.layer = layer;
    input.addEventListener("change", () => { if (input.checked) visibleLayers.add(layer); else visibleLayers.delete(layer); rebuild(); });
    label.append(input, ` ${layer}`); layerControls.append(label);
  }
  resize(); rebuild(); setView("iso");

  return {
    update(nextModel, nextOverlays) { model = nextModel; overlays = nextOverlays; options.selection.setModel(model); rebuild(); },
    focus,
    setFinding(findingId) {
      activeFindingId = findingId;
      const partId = overlays.findings.find((finding) => finding.id === findingId)?.partIds[0] ?? null;
      options.selection.select(partId, false); focus(partId);
    },
    setRoutesVisible(visible) { routesVisible = visible; routeGroup.visible = visible; render(); },
    setDimensionsVisible(visible) { dimensionsVisible = visible; dimensionGroup.visible = visible; render(); },
    setThermalVisible(visible) { thermalVisible = visible; thermalGroup.visible = visible && overlays.thermal.available; render(); },
    setAssemblyStep(index) { assemblyStepIndex = index; recolor(); },
    capture(filename) {
      render();
      renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
      }, "image/png");
    },
    getViewContext() {
      return {
        cameraMode,
        cameraPositionMm: camera.position.toArray(),
        targetMm: controls.target.toArray(),
        explode,
        routesVisible,
        dimensionsVisible,
        thermalVisible,
        activeFindingId,
        assemblyStepId: assemblyStepIndex === null ? null : overlays.assembly[assemblyStepIndex]?.id ?? null,
      };
    },
    reset() { setView("iso"); },
    dispose() {
      disposed = true; resizeObserver.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener("pointermove", onMove); renderer.domElement.removeEventListener("click", onClick);
      disposeGroup(rootGroup); disposeGroup(routeGroup); disposeGroup(dimensionGroup); disposeGroup(thermalGroup);
      renderer.dispose(); options.host.replaceChildren();
    },
  };
}
