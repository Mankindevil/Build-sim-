import { describe, expect, it } from "vitest";
import { transitionPlan, transitionProposal, transitionSaveStatus, transitionTransaction } from "../src/plans/state-machine";

describe("R0 plan state machines", () => {
  it("covers create, edit, save, archive, restore, duplicate, import and delete", () => {
    expect(transitionPlan("missing", "create")).toBe("active-dirty");
    expect(transitionPlan("missing", "import")).toBe("active-dirty");
    expect(transitionPlan("active-clean", "edit")).toBe("active-dirty");
    expect(transitionPlan("active-dirty", "autosave")).toBe("active-dirty");
    expect(transitionPlan("active-dirty", "save-version")).toBe("active-clean");
    expect(transitionPlan("active-clean", "archive")).toBe("archived");
    expect(transitionPlan("archived", "restore")).toBe("active-clean");
    expect(transitionPlan("archived", "duplicate")).toBe("active-dirty");
    expect(transitionPlan("archived", "delete")).toBe("deleted");
  });

  it("rejects invalid destructive and stale transitions", () => {
    expect(() => transitionPlan("deleted", "restore")).toThrow("Invalid plan lifecycle transition");
    expect(() => transitionPlan("active-dirty", "delete")).toThrow("Invalid plan lifecycle transition");
    expect(() => transitionProposal("applied", "rejected")).toThrow("Invalid proposal transition");
  });

  it("models saving, conflicts, failures and offline recovery", () => {
    expect(transitionSaveStatus("dirty", "saving")).toBe("saving");
    expect(transitionSaveStatus("saving", "conflict")).toBe("conflict");
    expect(transitionSaveStatus("conflict", "dirty")).toBe("dirty");
    expect(transitionSaveStatus("saving", "offline")).toBe("offline");
    expect(transitionSaveStatus("offline", "saving")).toBe("saving");
  });

  it("requires review and staging before transaction archive", () => {
    expect(transitionTransaction("selected", "reading")).toBe("reading");
    expect(transitionTransaction("reading", "recognizing")).toBe("recognizing");
    expect(transitionTransaction("recognizing", "enriching")).toBe("enriching");
    expect(transitionTransaction("enriching", "reviewing")).toBe("reviewing");
    expect(transitionTransaction("reviewing", "staged")).toBe("staged");
    expect(transitionTransaction("staged", "archiving")).toBe("archiving");
    expect(transitionTransaction("archiving", "archived")).toBe("archived");
    expect(() => transitionTransaction("reviewing", "archived")).toThrow("Invalid transaction transition");
  });
});

