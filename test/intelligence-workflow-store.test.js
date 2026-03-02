import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteIntelligenceWorkflow,
  readIntelligenceWorkflowStore,
  upsertIntelligenceWorkflow,
} from "../src/intelligence-workflow-store.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-intel-workflow-store-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("workflow store returns built-ins when file does not exist", async () => {
  await withTempDir(async (workspaceDir) => {
    const storePath = path.join(workspaceDir, "data", "intelligence-workflows.json");
    const store = await readIntelligenceWorkflowStore(storePath);
    assert.equal(Array.isArray(store.workflows), true);
    assert.equal(store.workflows.some((workflow) => workflow.id === "config-recommendations"), true);
    assert.equal(store.workflows.some((workflow) => workflow.id === "grimoire"), true);
  });
});

test("workflow store upsert and delete custom workflow", async () => {
  await withTempDir(async (workspaceDir) => {
    const storePath = path.join(workspaceDir, "data", "intelligence-workflows.json");
    const saved = await upsertIntelligenceWorkflow(storePath, {
      id: "custom-workflow-1",
      name: "Custom Workflow 1",
      type: "custom",
      description: "custom test",
    });
    assert.equal(saved.workflow?.id, "custom-workflow-1");

    const afterSave = await readIntelligenceWorkflowStore(storePath);
    assert.equal(afterSave.workflows.some((workflow) => workflow.id === "custom-workflow-1"), true);

    const afterDelete = await deleteIntelligenceWorkflow(storePath, "custom-workflow-1");
    assert.equal(afterDelete.workflows.some((workflow) => workflow.id === "custom-workflow-1"), false);
  });
});

test("workflow store does not allow deleting built-ins", async () => {
  await withTempDir(async (workspaceDir) => {
    const storePath = path.join(workspaceDir, "data", "intelligence-workflows.json");
    await assert.rejects(
      async () => {
        await deleteIntelligenceWorkflow(storePath, "grimoire");
      },
      /cannot be deleted/i,
    );
  });
});

