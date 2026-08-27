const EMPTY_VALUE_IDS = [
  "kpi-wall", "kpi-heat", "kpi-noise", "kpi-temp", "kpi-headroom", "kpi-price",
  "thermal-ambient", "noise-total", "controller-badge", "harness-count",
  "panel-wiring-badge", "routing-badge", "assembly-badge", "air-balance-badge",
  "purchased-total", "stage-total", "remaining-total", "grand-total", "future-total",
] as const;

const MESSAGE_IDS = [
  "kpi-wall-note", "kpi-btu", "kpi-noise-note", "kpi-temp-note", "kpi-headroom-note", "kpi-price-note",
  "route-title", "route-copy", "wiring-title", "wiring-notes", "harness-warning", "panel-wiring-notes", "routing-notes",
  "assembly-notes", "air-balance-notes", "calibration-status", "thermal-field-badge",
  "thermal-field-scale-note", "thermal-map-summary", "spatial-data-strip",
  "gpu-title", "gpu-safe-basis", "selected-total-label", "grand-total-label",
] as const;

const RESOLVED_CONTAINER_IDS = [
  "next-buy-list", "port-map", "drive-matrix", "panel-wiring", "routing-table", "assembly-steps",
  "air-balance", "air-assumptions", "temperature-bars", "heat-split", "noise-bars", "fan-advice",
  "power-scenarios", "gpu-detail", "gpu-score", "gpu-table", "price-table", "accessory-grid",
  "install-order-list", "pool-plan-list", "product-gallery", "spatial-scene", "spatial-screen-overlay",
  "thermal-flow-paths", "thermal-field-labels", "drive-svg-slots", "side-drive-slots",
  "rear-drive-slots", "side-psu-extra",
] as const;

function element(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

/** Remove conclusions produced by a previous ready evaluation before showing a partial draft. */
export function clearPartialResolvedSurfaces(root: ParentNode, message: string): void {
  const lab = element(root, "n6-lab");
  if (lab) lab.dataset.evaluationReadiness = "incomplete";

  for (const id of RESOLVED_CONTAINER_IDS) element(root, id)?.replaceChildren();
  for (const id of EMPTY_VALUE_IDS) {
    const target = element(root, id);
    if (target) target.textContent = "—";
  }
  for (const id of MESSAGE_IDS) {
    const target = element(root, id);
    if (target) target.textContent = message;
  }

  element(root, "route-copy")?.removeAttribute("title");
  element(root, "spatial-routes")?.setAttribute("aria-pressed", "false");
  for (const target of root.querySelectorAll<HTMLElement>("[data-evaluation-hash]")) target.removeAttribute("data-evaluation-hash");
  for (const target of root.querySelectorAll<HTMLElement>("[data-level]")) {
    if (["harness-warning", "panel-wiring-notes", "routing-notes", "assembly-notes", "air-balance-notes"].includes(target.id)) {
      target.dataset.level = "warn";
    }
  }

  const canvas = element(root, "thermal-field") as HTMLCanvasElement | null;
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

export function markResolvedSurfacesReady(root: ParentNode): void {
  const lab = element(root, "n6-lab");
  if (lab) lab.dataset.evaluationReadiness = "ready";
}
