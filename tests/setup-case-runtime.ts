import adapterSeed from "../data/cases/jonsbo-n6/adapter.json";
import {
  compileLockedCaseAdapterRuntime,
  createBundledCaseRuntimeModels,
  materializeCaseAdapterFixtureSeed,
  registerBuiltInCaseRuntimeAdapter,
  type CaseAdapterSeed,
} from "../src/adapters";

// Deliberate flag-on test composition: the default evaluator receives a runtime
// compiled from the production data-only registration and imports no case
// implementation.
const materialized = await materializeCaseAdapterFixtureSeed(adapterSeed as unknown as CaseAdapterSeed);
const [model] = await createBundledCaseRuntimeModels([materialized.manifest]);
if (!model) throw new Error("bundled data-only case runtime model is unavailable");
registerBuiltInCaseRuntimeAdapter(await compileLockedCaseAdapterRuntime(materialized.manifest, model));
