import appDocument from "./app-document.html?raw";

/**
 * Page-lifetime compatibility loader. The lifecycle platform mounts into the
 * legacy N6 detail template, while PlanStore/BuildEvaluation remain the only
 * authoritative plan/fact sources. Keeping the template inert until this
 * module runs prevents its former script tag from creating a second boot path.
 */
const parsed = new DOMParser().parseFromString(appDocument, "text/html");
document.documentElement.lang = parsed.documentElement.lang || "zh-CN";
document.title = parsed.title || document.title;
for (const style of parsed.head.querySelectorAll("style,link[rel=stylesheet]")) document.head.append(style.cloneNode(true));
document.body.replaceChildren(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));

await import("./boot");
