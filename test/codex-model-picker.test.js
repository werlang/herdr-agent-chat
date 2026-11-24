import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCodexModel,
  codexAppServerVersion,
  codexModelEffort,
  codexScreenModel,
  codexSupportsInlineModel,
} from "../mods/agent-chat/codex-model-picker.js";

const terra = {
  slug: "gpt-6.1-terra",
  display_name: "GPT-6.1 Terra",
  default_reasoning_level: "low",
  supported_reasoning_levels: ["low", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
};
const sol = { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", default_reasoning_level: "low" };
const models = [sol, terra];

test("Codex applies one inline command for a model switch or an effort-only switch", async () => {
  for (const [effortOnly, initial, effort, command, confirmed] of [
    [false, "GPT-6.2-Sol low · ~/project", "ultra", "/model gpt-6.1-terra --reasoning=ultra",
      "• Model changed to gpt-6.1-terra ultra for this conversation\n\n» Ask Codex to do anything\n\n  GPT-6.1 Terra max · ~/project"],
    [true, "GPT-6.1 Terra ultra · ~/project", "high", "/model --reasoning=high",
      "• Model changed to gpt-6.1-terra high for this conversation\n\n› Ask Codex to do anything"],
  ]) {
    let sent = false;
    let reads = 0;
    const result = await applyCodexModel({
      model: terra,
      models,
      effort,
      effortOnly,
      wait: async () => {},
      send: async (text) => {
        assert.equal(sent, false);
        assert.equal(text, command);
        sent = true;
      },
      read: async () => ++reads < 3 ? initial : confirmed,
    });
    assert.equal(sent, true);
    assert.equal(result, confirmed);
    assert.deepEqual(codexScreenModel(result, models), { model: terra.slug, effort });
  }
});

test("Codex preserves an open native picker and refuses stale effort choices", async () => {
  const common = {
    model: terra, models, effort: "high", effortOnly: true, wait: async () => {},
    send: async () => assert.fail("sent a command against a stale native state"),
  };
  await assert.rejects(applyCodexModel({
    ...common, read: async () => "Select Reasoning Level for GPT-6.1 Terra\n› 1. Low (default)",
  }), /Close the open \/model menu/);
  await assert.rejects(applyCodexModel({
    ...common, read: async () => "GPT-6.2-Sol low · ~/project",
  }), /active Codex model changed/);
});

test("Codex reports a rejected reasoning effort and does not claim success", async () => {
  let sent = false;
  await assert.rejects(applyCodexModel({
    model: terra, models, effort: "ultra", effortOnly: true, wait: async () => {},
    send: async () => { sent = true; },
    read: async () => sent
      ? "• Reasoning level 'ultra' is unavailable for gpt-6.1-terra. Available: low, high.\nGPT-6.1 Terra low · ~/project"
      : "GPT-6.1 Terra low · ~/project",
  }), /Reasoning level 'ultra' is unavailable/);
});

test("Codex only uses inline model commands on supported builds", () => {
  const catalogueVersion = codexAppServerVersion(
    'app-server starting\n{"id":1,"result":{"userAgent":"herdr/0.171.0 (Mac OS; arm64) ghostty"}}',
  );
  assert.equal(catalogueVersion, "0.171.0");
  assert.equal(codexSupportsInlineModel("", catalogueVersion), true);
  assert.equal(codexSupportsInlineModel("  >_ OpenAI Codex (v0.163.0)", catalogueVersion), false);
  assert.equal(codexSupportsInlineModel("  >_ OpenAI Codex (v0.164.0)", null), true);
  assert.equal(codexSupportsInlineModel("", null), false);
});

test("Codex shows its model default and preserves only effort the destination supports", () => {
  assert.deepEqual(codexScreenModel("  GPT-6.1 Terra default · ~/project", models), {
    model: "gpt-6.1-terra", effort: "low",
  });
  assert.equal(codexModelEffort(terra, "xhigh"), "xhigh");
  assert.equal(codexModelEffort(terra, "medium"), "low");
});
