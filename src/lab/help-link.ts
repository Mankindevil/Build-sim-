import { STORAGE_HELP } from "../storage/explain";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../system-profiles/registry";

export interface HelpEntry {
  readonly helpRef: string;
  readonly title: string;
  readonly body: string;
  readonly sourceRefs: readonly string[];
}

const SYSTEM_HELP: HelpEntry[] = DEFAULT_SYSTEM_PROFILE_REGISTRY.list().map((profile) => ({
  helpRef: profile.helpRef,
  title: profile.label,
  body: `${profile.label} 的系统可用性与机械兼容分开评估。必须满足：${profile.requiredChecks.join("、")}。默认建议可修改，用户选择会锁定。`,
  sourceRefs: [...profile.officialSourceRefs],
}));

export const HELP_ENTRIES: readonly HelpEntry[] = Object.freeze([
  ...SYSTEM_HELP,
  ...Object.values(STORAGE_HELP).map((entry) => ({ ...entry, sourceRefs: ["guide:system-selection"] })),
]);

export function resolveHelpEntry(helpRef: string): HelpEntry | null {
  return HELP_ENTRIES.find((entry) => entry.helpRef === helpRef) ?? null;
}

function ensureDialog(): HTMLDialogElement {
  const existing = document.querySelector<HTMLDialogElement>("[data-buildsim-help-dialog]");
  if (existing) return existing;
  const dialog = document.createElement("dialog");
  dialog.dataset.buildsimHelpDialog = "true";
  dialog.setAttribute("aria-labelledby", "buildsim-help-title");
  const article = document.createElement("article");
  article.className = "workspace-dialog-card";
  const header = document.createElement("header");
  const heading = document.createElement("h2"); heading.id = "buildsim-help-title";
  const close = document.createElement("button"); close.type = "button"; close.textContent = "关闭"; close.setAttribute("aria-label", "关闭说明");
  header.append(heading, close);
  const body = document.createElement("p"); body.dataset.helpBody = "true";
  const sources = document.createElement("ul"); sources.dataset.helpSources = "true";
  article.append(header, body, sources); dialog.append(article); document.body.append(dialog);
  close.addEventListener("click", () => {
    if (typeof dialog.close === "function") dialog.close();
    else {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    }
  });
  return dialog;
}

export function createHelpButton(helpRef: string, label: string): HTMLButtonElement {
  const entry = resolveHelpEntry(helpRef);
  if (!entry) throw new RangeError(`Unknown helpRef: ${helpRef}`);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-help-button";
  button.textContent = "?";
  button.dataset.helpRef = helpRef;
  button.setAttribute("aria-label", `了解${label}`);
  button.addEventListener("click", () => {
    const dialog = ensureDialog();
    const heading = dialog.querySelector<HTMLElement>("#buildsim-help-title")!;
    const body = dialog.querySelector<HTMLElement>("[data-help-body]")!;
    const sources = dialog.querySelector<HTMLElement>("[data-help-sources]")!;
    heading.textContent = entry.title;
    body.textContent = entry.body;
    sources.replaceChildren(...entry.sourceRefs.map((sourceRef) => {
      const item = document.createElement("li"); item.textContent = sourceRef; return item;
    }));
    dialog.addEventListener("close", () => button.focus(), { once: true });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  });
  return button;
}
