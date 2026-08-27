/**
 * Runtime trust boundary for server-issued repository/runner state.
 *
 * The brand is intentionally not serializable and is backed by module-private
 * WeakSets. A structurally similar object, JSON clone, or hand-written resolver
 * is therefore rejected at runtime, even when a caller defeats TypeScript.
 */

declare const trustedResolutionBrand: unique symbol;
declare const authoritativeResolverBrand: unique symbol;

export type AuthoritativeContextKind =
  | "purchase-eligibility-context"
  | "recommendation-context"
  | "listing-capture"
  | "safety-checkpoint-context"
  | "readiness-inputs"
  | "procedure-dependency-context"
  | "execution-validation-context"
  | "destructive-action-context"
  | "portable-closure-context"
  | "backup-verification-context"
  | "doctor-verification-context"
  | "repair-execution-context";

export interface TrustedResolution<T> {
  readonly ref: string;
  readonly value: T;
  readonly [trustedResolutionBrand]: true;
}

export interface AuthoritativeResolver<T, Kind extends AuthoritativeContextKind = AuthoritativeContextKind> {
  readonly authorityKind: Kind;
  readonly [authoritativeResolverBrand]: true;
  resolve(ref: string): Promise<TrustedResolution<T>>;
}

export type AuthoritativeResolution<T> =
  | { ok: true; ref: string; value: T }
  | { ok: false; error: string };

const issuedResolvers = new WeakSet<object>();
const issuedResolutions = new WeakSet<object>();

function nonEmptyRef(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Server composition-root factory. Request payloads must never select or invoke
 * this factory; they may provide only the stable ref passed to an already
 * injected resolver.
 */
export function createAuthoritativeResolver<T, Kind extends AuthoritativeContextKind>(
  authorityKind: Kind,
  load: (ref: string) => T | undefined | Promise<T | undefined>,
): AuthoritativeResolver<T, Kind> {
  if (typeof load !== "function") throw new TypeError("authoritative resolver requires a loader");
  const resolver = {
    authorityKind,
    async resolve(ref: string): Promise<TrustedResolution<T>> {
      if (!nonEmptyRef(ref)) throw new TypeError("authoritative reference must be a non-empty string");
      const value = await load(ref);
      if (value === undefined) throw new Error(`authoritative reference not found: ${ref}`);
      const resolution = Object.freeze({ ref, value }) as unknown as TrustedResolution<T>;
      issuedResolutions.add(resolution);
      return resolution;
    },
  } as unknown as AuthoritativeResolver<T, Kind>;
  issuedResolvers.add(resolver);
  return Object.freeze(resolver);
}

export function isTrustedResolution<T>(value: unknown, ref?: string): value is TrustedResolution<T> {
  return typeof value === "object" && value !== null && issuedResolutions.has(value)
    && (ref === undefined || (value as { ref?: unknown }).ref === ref);
}

/** Resolve only through a module-issued resolver and resolution pair. */
export async function resolveAuthoritativeContext<T, Kind extends AuthoritativeContextKind>(
  resolver: unknown,
  authorityKind: Kind,
  ref: unknown,
): Promise<AuthoritativeResolution<T>> {
  if (!nonEmptyRef(ref)) return { ok: false, error: "authoritative reference must be a non-empty string" };
  if (typeof resolver !== "object" || resolver === null || !issuedResolvers.has(resolver)) {
    return { ok: false, error: "resolver was not issued by the server composition root" };
  }
  const typed = resolver as AuthoritativeResolver<T>;
  if (typed.authorityKind !== authorityKind) return { ok: false, error: `resolver authority mismatch: expected ${authorityKind}` };
  try {
    const resolution = await typed.resolve(ref);
    if (!isTrustedResolution<T>(resolution, ref)) return { ok: false, error: "resolver returned an untrusted or mismatched resolution" };
    return { ok: true, ref, value: resolution.value };
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    return { ok: false, error: `authoritative resolution failed${detail}` };
  }
}
