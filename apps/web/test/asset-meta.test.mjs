import assert from "node:assert/strict";
import test from "node:test";
import { i18n } from "../src/i18n/index.ts";
import {
  assetDetail,
  assetName,
  assetStatusLabel,
} from "../src/lib/asset-meta.ts";

const pool = {
  id: "asset_local_worktree_pool",
  name: "Issue worktrees",
  kind: "worktree_pool",
  status: "available",
  detail: "~/.foundry/workspaces/ws_1/environments",
};
const evidence = {
  id: "asset_local_artifact_archive",
  name: "Evidence store",
  kind: "artifact_archive",
  status: "available",
  detail: "~/.foundry/workspaces/ws_1/evidence-store",
};
const preview = {
  id: "asset_local_preview_ports",
  name: "Local preview ports",
  kind: "preview_ports",
  status: "missing",
  detail: "copy preview.example.json to preview.json",
};

test("worker asset names, statuses and known details follow the viewer's language", async () => {
  await i18n.changeLanguage("zh-CN");
  assert.equal(assetName(pool), "Issue worktree");
  assert.equal(assetName(evidence), "证据存储");
  assert.equal(assetStatusLabel("available"), "可用");
  assert.equal(assetStatusLabel("missing"), "缺失");
  assert.equal(
    assetDetail(pool),
    "每个 Issue 一个 git worktree · ~/.foundry/workspaces/ws_1/environments",
  );
  assert.match(assetDetail(preview), /^未配置：/);
  await i18n.changeLanguage("en");
  assert.equal(assetName(preview), "Preview ports");
  assert.equal(assetStatusLabel("leased"), "In use");
  assert.match(
    assetDetail(evidence),
    /accepted changes merge into the repository · ~\/\.foundry\/workspaces\/ws_1\/evidence-store$/,
  );
  assert.equal(
    assetDetail({ ...pool, detail: "per_issue · .foundry/assets.yaml" }),
    "One git worktree per Issue",
    "an older worker's config-file detail is not shown as configuration",
  );
  assert.equal(
    assetDetail({ ...pool, detail: "something new" }),
    "something new",
    "unknown details pass through",
  );
});
