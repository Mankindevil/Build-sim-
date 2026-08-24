const BARRIERS = [
  {
    kind: "captcha",
    patterns: [
      /<iframe[^>]+(?:recaptcha|hcaptcha)/i,
      /<(?:div|form)[^>]+(?:id|class)=["'][^"']*(?:captcha|cf-chl)/i,
      /(?:verify (?:that )?you are human|checking (?:your )?browser|complete the security check)/i,
    ],
    manualAction: "Open the official page in a normal browser and complete the human verification; do not automate or bypass it.",
  },
  {
    kind: "login-wall",
    patterns: [
      /(?:sign in|log in|login) (?:is )?required to (?:continue|view|access)/i,
      /(?:please|you must) (?:sign in|log in) to (?:continue|view|access)/i,
    ],
    manualAction: "Use an authorized browser session to review the page manually; credentials and cookies are never forwarded by the catalog fetcher.",
  },
  {
    kind: "paywall",
    patterns: [
      /<(?:div|section)[^>]+(?:id|class)=["'][^"']*paywall/i,
      /(?:subscribe|subscription required|purchase access) to (?:continue|read|view)/i,
    ],
    manualAction: "Review access rights manually or use another official public source; the pipeline does not bypass paywalls.",
  },
];

function boundedSignals(patterns, body) {
  return patterns.flatMap((pattern) => {
    const match = body.match(pattern);
    return match ? [String(match[0]).replace(/\s+/g, " ").slice(0, 120)] : [];
  });
}

export function detectAccessBarrier(fetchResult) {
  const status = Number(fetchResult?.status ?? 0);
  if (status === 429) return { kind: "rate-limit", status, signals: ["HTTP 429"], manualAction: "Retry later within the official site's published access limits." };
  if (status === 401) return { kind: "login-wall", status, signals: ["HTTP 401"], manualAction: BARRIERS[1].manualAction };
  if (status === 402) return { kind: "paywall", status, signals: ["HTTP 402"], manualAction: BARRIERS[2].manualAction };
  if (status === 403) return { kind: "access-denied", status, signals: ["HTTP 403"], manualAction: "Review the official page manually; the pipeline does not evade access controls." };
  if (!String(fetchResult?.contentType ?? "").includes("html")) return null;
  const body = String(fetchResult?.body ?? "").slice(0, 2_000_000);
  for (const barrier of BARRIERS) {
    const signals = boundedSignals(barrier.patterns, body);
    if (signals.length) return { kind: barrier.kind, status, signals, manualAction: barrier.manualAction };
  }
  return null;
}
