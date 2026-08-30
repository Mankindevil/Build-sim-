import { hashContent } from "../hash";

export type AttachmentAnnotationSubject =
  | { readonly kind: "instance"; readonly instanceId: string }
  | { readonly kind: "port"; readonly instanceId: string; readonly portId: string }
  | { readonly kind: "mount"; readonly ownerInstanceId: string; readonly mountId: string };

export interface ImagePointPx {
  readonly x: number;
  readonly y: number;
}

export interface AttachmentScaleReference {
  readonly firstPx: ImagePointPx;
  readonly secondPx: ImagePointPx;
  readonly knownDistanceMm: number;
  readonly plusMinusMm: number;
  readonly authorityRef: string;
}

export interface CreateAttachmentAnnotationInput {
  readonly annotationId: string;
  readonly attachmentId: string;
  readonly planId: string;
  readonly subject: AttachmentAnnotationSubject;
  readonly kind: "two_point_distance" | "interface_direction";
  readonly imageSizePx: { readonly width: number; readonly height: number };
  readonly firstPx: ImagePointPx;
  readonly secondPx: ImagePointPx;
  readonly scale: AttachmentScaleReference | null;
  readonly capturedAt: string;
}

export interface AttachmentAnnotation extends CreateAttachmentAnnotationInput {
  readonly schemaVersion: "attachment-annotation-v1";
  readonly pixelDistance: number;
  readonly directionImageUnit: readonly [number, number];
  readonly measurement: {
    readonly status: "absolute" | "relative_only" | "direction_only";
    readonly valueMm: number | null;
    readonly plusMinusMm: number | null;
  };
  readonly contentHash: string;
}

const pointDistance = (left: ImagePointPx, right: ImagePointPx): number => Math.hypot(right.x - left.x, right.y - left.y);

function validatePoint(point: ImagePointPx, width: number, height: number): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
    throw new TypeError("attachment annotation point lies outside the image");
  }
}

function validateSubject(subject: AttachmentAnnotationSubject): void {
  const values = Object.values(subject);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("attachment annotation subject is invalid");
  }
}

export async function createAttachmentAnnotation(input: CreateAttachmentAnnotationInput): Promise<AttachmentAnnotation> {
  const exactInputFields = ["annotationId", "attachmentId", "planId", "subject", "kind", "imageSizePx", "firstPx", "secondPx", "scale", "capturedAt"];
  if (Object.keys(input).length !== exactInputFields.length || Object.keys(input).some((field) => !exactInputFields.includes(field))) {
    throw new TypeError("attachment annotation contains unknown fields");
  }
  const subjectFields = input.subject.kind === "instance" ? ["kind", "instanceId"]
    : input.subject.kind === "port" ? ["kind", "instanceId", "portId"]
      : input.subject.kind === "mount" ? ["kind", "ownerInstanceId", "mountId"] : [];
  if (Object.keys(input.subject).length !== subjectFields.length || Object.keys(input.subject).some((field) => !subjectFields.includes(field))) {
    throw new TypeError("attachment annotation subject contains unknown fields");
  }
  if (!input.annotationId || !input.attachmentId || !input.planId || !Number.isInteger(input.imageSizePx.width)
    || !Number.isInteger(input.imageSizePx.height) || input.imageSizePx.width <= 0 || input.imageSizePx.height <= 0
    || !Number.isFinite(Date.parse(input.capturedAt))) throw new TypeError("attachment annotation identity is invalid");
  validateSubject(input.subject);
  validatePoint(input.firstPx, input.imageSizePx.width, input.imageSizePx.height);
  validatePoint(input.secondPx, input.imageSizePx.width, input.imageSizePx.height);
  const pixelDistance = pointDistance(input.firstPx, input.secondPx);
  if (pixelDistance <= 0) throw new TypeError("attachment annotation endpoints must be distinct");
  const directionImageUnit = [
    (input.secondPx.x - input.firstPx.x) / pixelDistance,
    (input.secondPx.y - input.firstPx.y) / pixelDistance,
  ] as const;
  let measurement: AttachmentAnnotation["measurement"];
  if (input.kind === "interface_direction") {
    if (input.scale !== null) throw new TypeError("direction annotation must not claim a distance scale");
    measurement = { status: "direction_only", valueMm: null, plusMinusMm: null };
  } else if (input.scale === null) {
    measurement = { status: "relative_only", valueMm: null, plusMinusMm: null };
  } else {
    const scaleFields = ["firstPx", "secondPx", "knownDistanceMm", "plusMinusMm", "authorityRef"];
    if (Object.keys(input.scale).length !== scaleFields.length || Object.keys(input.scale).some((field) => !scaleFields.includes(field))) {
      throw new TypeError("attachment annotation scale contains unknown fields");
    }
    validatePoint(input.scale.firstPx, input.imageSizePx.width, input.imageSizePx.height);
    validatePoint(input.scale.secondPx, input.imageSizePx.width, input.imageSizePx.height);
    const scalePixels = pointDistance(input.scale.firstPx, input.scale.secondPx);
    if (scalePixels <= 0 || !Number.isFinite(input.scale.knownDistanceMm) || input.scale.knownDistanceMm <= 0
      || !Number.isFinite(input.scale.plusMinusMm) || input.scale.plusMinusMm < 0 || !input.scale.authorityRef) {
      throw new TypeError("attachment annotation scale is invalid");
    }
    const mmPerPixel = input.scale.knownDistanceMm / scalePixels;
    const valueMm = pixelDistance * mmPerPixel;
    // One-pixel endpoint picking error at each end plus reference uncertainty.
    const plusMinusMm = 2 * mmPerPixel + valueMm * input.scale.plusMinusMm / input.scale.knownDistanceMm;
    measurement = { status: "absolute", valueMm, plusMinusMm };
  }
  const material = {
    schemaVersion: "attachment-annotation-v1" as const,
    ...structuredClone(input), pixelDistance, directionImageUnit, measurement,
  };
  return {
    ...material,
    contentHash: await hashContent(material, { domain: "spatial-topology", schemaVersion: "1.0.0" }),
  };
}

export interface AnnotationDependentDecision {
  readonly decisionId: string;
  readonly annotationIds: readonly string[];
}

/** Returns only decisions whose exact annotation dependency changed. */
export function decisionsAffectedByAnnotation(
  decisions: readonly AnnotationDependentDecision[],
  annotationId: string,
): readonly string[] {
  if (!annotationId) throw new TypeError("annotation identity is invalid");
  return decisions.filter((entry) => entry.annotationIds.includes(annotationId)).map((entry) => entry.decisionId).sort();
}
