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
  name: "Local worktree pool",
  kind: "worktree_pool",
  status: "available",
  detail: "per_issue · .foundry/assets.yaml",
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
  assert.equal(assetName(pool), "Worktree 池");
  assert.equal(assetStatusLabel("available"), "可用");
  assert.equal(assetStatusLabel("missing"), "缺失");
  assert.equal(
    assetDetail(pool),
    "每个 Issue 一个 worktree · .foundry/assets.yaml",
  );
  assert.match(assetDetail(preview), /^未配置：/);
  await i18n.changeLanguage("en");
  assert.equal(assetName(preview), "Preview ports");
  assert.equal(assetStatusLabel("leased"), "In use");
  assert.equal(
    assetDetail({ ...pool, detail: "custom · .foundry/assets.yaml" }),
    "custom · .foundry/assets.yaml",
  );
  assert.equal(
    assetDetail({ ...pool, detail: "something new" }),
    "something new",
    "unknown details pass through",
  );
});
