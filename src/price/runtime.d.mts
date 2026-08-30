import type { ImmutableListingCapture, JobSchedule, PriceHistoryPoint, PriceObservation, PriceTarget, PriceTargetEvent } from "./contracts";

export function validateImmutableListingCaptureRuntime(value: unknown): string[];
export function validatePriceObservationRuntime(value: unknown): string[];
export function validatePriceObservationClosureRuntime(value: unknown, capture: unknown): string[];
export function validatePriceHistoryPointRuntime(value: unknown): string[];
export function validatePriceHistoryClosureRuntime(value: unknown, observations: readonly unknown[]): string[];
export function validatePriceTargetRuntime(value: unknown): string[];
export function priceTargetEventIdempotencyKeyRuntime(value: Pick<PriceTargetEvent, "targetId" | "targetRevisionHash" | "priceSnapshotId" | "transition">): string;
export function validatePriceTargetEventRuntime(value: unknown): string[];
export function validateJobScheduleRuntime(value: unknown): string[];

export type { ImmutableListingCapture, JobSchedule, PriceHistoryPoint, PriceObservation, PriceTarget, PriceTargetEvent };
