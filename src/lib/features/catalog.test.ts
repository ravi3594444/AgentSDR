import { describe, expect, test } from "bun:test";
import { defaultFeatureState, featureStateFromRows, FEATURE_KEYS } from "./catalog";

describe("workspace feature defaults", () => {
  test("uses the improved research agent without opting in", () => {
    const state = defaultFeatureState();
    expect(state.research_agent_v2).toBe(true);
    for (const key of FEATURE_KEYS) {
      if (key !== "research_agent_v2") expect(state[key]).toBe(false);
    }
  });

  test("one workspace's changed state does not change another's defaults", () => {
    const state = defaultFeatureState();
    state.research_agent_v2 = false;
    state.brightdata = true;
    expect(defaultFeatureState().research_agent_v2).toBe(true);
    expect(defaultFeatureState().brightdata).toBe(false);
  });

  test("an existing workspace without a saved research choice uses v2", () => {
    const state = featureStateFromRows([{ key: "instagram", enabled: true }]);
    expect(state.research_agent_v2).toBe(true);
    expect(state.instagram).toBe(true);
    expect(state.brightdata).toBe(false);
  });

  test("a saved opt-out survives reloads and later default resolution", () => {
    const rows = [{ key: "research_agent_v2", enabled: false }];
    expect(featureStateFromRows(rows).research_agent_v2).toBe(false);
    expect(featureStateFromRows(rows).research_agent_v2).toBe(false);
    expect(featureStateFromRows([]).research_agent_v2).toBe(true);
  });

  test("saved provider choices remain unchanged and unknown keys are ignored", () => {
    const state = featureStateFromRows([
      { key: "research_agent_v2", enabled: true },
      { key: "brightdata", enabled: false },
      { key: "apify_discovery", enabled: true },
      { key: "unknown_feature", enabled: true },
    ]);
    expect(state.research_agent_v2).toBe(true);
    expect(state.brightdata).toBe(false);
    expect(state.apify_discovery).toBe(true);
    expect(state).not.toHaveProperty("unknown_feature");
  });
});
