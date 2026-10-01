import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { resources } = await import("../src/i18n/resources.ts");
const { browserLocale, resolveLocale, i18n } =
  await import("../src/i18n/index.ts");

function leaves(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "string"
      ? [[`${prefix}${key}`, child]]
      : leaves(child, `${prefix}${key}.`),
  );
}

const placeholders = (text) =>
  [...text.matchAll(/{{\s*(\w+)/g)].map((match) => match[1]).sort();
const tags = (text) =>
  [...text.matchAll(/<(\w+)>/g)].map((match) => match[1]).sort();

test("every locale translates every key of every namespace, with the same placeholders", () => {
  for (const [locale, namespaces] of Object.entries(resources)) {
    assert.deepEqual(
      Object.keys(namespaces).sort(),
      Object.keys(resources.en).sort(),
      `${locale} namespaces`,
    );
    for (const [namespace, english] of Object.entries(resources.en)) {
      const translated = new Map(leaves(namespaces[namespace]));
      for (const [key, text] of leaves(english)) {
        const other = translated.get(key);
        assert.ok(other?.trim(), `${locale} ${namespace}:${key} is missing`);
        assert.deepEqual(
          placeholders(other),
          placeholders(text),
          `${locale} ${namespace}:${key} placeholders`,
        );
        assert.deepEqual(
          tags(other),
          tags(text),
          `${locale} ${namespace}:${key} markup`,
        );
      }
      assert.equal(
        translated.size,
        leaves(english).length,
        `${locale} ${namespace} has extra keys`,
      );
    }
  }
});

test("the interface follows the account's choice, else the browser's language", () => {
  assert.equal(browserLocale(["zh-TW", "en-US"]), "zh-CN");
  assert.equal(browserLocale(["en-GB"]), "en");
  assert.equal(browserLocale(["fr-FR"]), "en");
  assert.equal(resolveLocale("zh-CN"), "zh-CN");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("tlh"), browserLocale());
});

test("copy renders in the chosen language", async () => {
  await i18n.changeLanguage("zh-CN");
  assert.equal(i18n.t("shell:nav.devices"), "设备");
  assert.equal(
    i18n.t("common:access.denied", { have: "成员", need: "维护者" }),
    "你在这个工作区是成员；这项操作需要维护者或更高的角色。",
  );
  await i18n.changeLanguage("en");
  assert.equal(i18n.t("shell:nav.devices"), "Devices");
});
