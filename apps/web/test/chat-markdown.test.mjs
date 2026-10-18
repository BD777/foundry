import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

async function renderMarkdown(props, text, inspect) {
  const window = new Window();
  let root;
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IntersectionObserver: window.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "Event", "MouseEvent"])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const { MarkdownContent } =
      await import("../src/components/conversation/markdown-content.tsx");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(createElement(MarkdownContent, props, text)),
    );
    const html = container.innerHTML;
    await inspect?.(container, async (nextProps, nextText = text) => {
      await act(async () =>
        root.render(createElement(MarkdownContent, nextProps, nextText)),
      );
    });
    return html;
  } finally {
    if (root) await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

test("Mermaid fences render diagrams after streaming ends; ordinary code stays code", async () => {
  const source = 'flowchart TD\n  A["开始"] --> B["完成<br/>Done"]';
  const markdown = `\`\`\`mermaid\n${source}\n\`\`\``;
  await renderMarkdown(
    { streaming: true },
    markdown,
    async (container, update) => {
      assert.equal(
        container.querySelector('[data-streamdown="mermaid-block"]'),
        null,
      );
      assert.match(container.textContent, /flowchart TD/);

      await update({ streaming: false });
      // Streamdown lazy-loads its diagram UI through Suspense. Wait for that
      // observable result, including under concurrent test/build CPU load.
      const deadline = Date.now() + 5000;
      while (
        !container.querySelector('[data-streamdown="mermaid-block"]') &&
        Date.now() < deadline
      ) {
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 20)),
        );
      }
      assert.ok(container.querySelector('[data-streamdown="mermaid-block"]'));
      assert.ok(
        container.querySelector('button[aria-label="View fullscreen"]'),
      );
      assert.ok(
        container.querySelector('button[aria-label="Download diagram"]'),
      );

      await update({}, '```js\nconst chart = "flowchart TD";\n```');
      assert.equal(
        container.querySelector('[data-streamdown="mermaid-block"]'),
        null,
      );
      assert.match(container.textContent, /const chart/);
    },
  );
});

test("a person's message keeps its line breaks and literal list markers", async () => {
  const html = await renderMarkdown(
    { typedText: true },
    "我试了：\n1. 刷新页面\n2. 重启 worker",
  );
  assert.equal(html.match(/<br>/g)?.length, 2);
  assert.match(html, /1\. 刷新页面/);
  assert.doesNotMatch(html, /<ol/);
});

test("an agent answer keeps Markdown soft breaks and GFM task lists", async () => {
  const html = await renderMarkdown(
    {},
    "line one\nline two\n\n- [x] done\n- [ ] todo",
  );
  assert.doesNotMatch(html, /<br>/);
  assert.match(html, /<ul class="contains-task-list">/);
  assert.equal(html.match(/<li class="task-list-item">/g)?.length, 2);
});

test("CJK emphasis next to punctuation renders in streaming and settled text", async () => {
  const cases = [
    [
      "**目前没有必须请你 review 或拍板的地方。**按你已经明确的原则",
      "strong",
      "目前没有必须请你 review 或拍板的地方。",
    ],
    ["- **高置信度：**下架后重复对账需要收敛", "strong", "高置信度："],
    [
      "- **需要实现和测试证明：**残差保留与强平风控",
      "strong",
      "需要实现和测试证明：",
    ],
    [
      "唯一涉及策略取舍的是：**是否主动单腿清理本来合法的 dust。**你已经说过",
      "strong",
      "是否主动单腿清理本来合法的 dust。",
    ],
    [
      "**重要提示（Important Notice）：**请注意",
      "strong",
      "重要提示（Important Notice）：",
    ],
    ["*中文斜体。*继续", "em", "中文斜体。"],
    ["~~旧方案。~~新方案", "del", "旧方案。"],
  ];
  for (const props of [
    { streaming: true },
    { streaming: false },
    { typedText: true },
  ]) {
    for (const [source, kind, text] of cases) {
      await renderMarkdown(props, source, (container) => {
        const formatted = container.querySelector(
          `[data-streamdown="${kind}"], ${kind}`,
        );
        assert.equal(
          formatted?.textContent,
          text,
          `${JSON.stringify(props)}: ${source}`,
        );
        assert.doesNotMatch(container.textContent, /\*\*|~~/);
      });
    }
  }
});

test("CJK parsing preserves mixed GFM structure, nested formatting, code and escapes", async () => {
  const source = [
    "## 验收",
    "",
    "> **结论：**保留 *斜体。*继续与 ~~旧方案。~~更新。",
    "",
    "- **父项：**正文",
    "  - **子项：**正文",
    "",
    "1. **步骤：**执行",
    "2. **步骤：**完成",
    "",
    "| 项目 | 状态 |",
    "| --- | --- |",
    "| 加粗 | **通过：**继续 |",
    "",
    "**包含 `code` 和 [链接](https://example.com) 的内容。**继续。",
    "",
    "`**代码：**原样` 和 \\*\\*转义：\\*\\*原样。",
    "",
    "```text",
    "**示例：**原样",
    "~~示例。~~原样",
    "```",
  ].join("\n");
  for (const streaming of [true, false]) {
    await renderMarkdown({ streaming }, source, (container) => {
      assert.equal(container.querySelector("h2")?.textContent, "验收");
      assert.ok(container.querySelector("blockquote em"));
      assert.ok(container.querySelector("blockquote del"));
      assert.ok(container.querySelector("ul ul li"));
      assert.equal(container.querySelectorAll("ol li").length, 2);
      assert.equal(container.querySelectorAll("td").length, 2);
      const strong = [
        ...container.querySelectorAll('[data-streamdown="strong"]'),
      ];
      assert.equal(strong.length, 7);
      const nested = strong.find((node) => node.textContent.startsWith("包含"));
      assert.equal(nested?.querySelector("code")?.textContent, "code");
      assert.equal(
        nested?.querySelector("a")?.getAttribute("href"),
        "https://example.com/",
      );
      assert.ok(
        [...container.querySelectorAll("code")].some(
          (node) => node.textContent === "**代码：**原样",
        ),
      );
      assert.match(
        container.querySelector("pre")?.textContent ?? "",
        /\*\*示例：\*\*原样/,
      );
      assert.match(container.textContent, /\*\*转义：\*\*原样/);
    });
  }
});

test("finishing a streamed CJK emphasis keeps formatting and literal text stable", async () => {
  const source = "**高置信度：**下架后重复对账需要收敛。";
  await renderMarkdown(
    { streaming: true },
    source,
    async (container, update) => {
      const before = container.textContent;
      assert.equal(
        container.querySelector('[data-streamdown="strong"]')?.textContent,
        "高置信度：",
      );
      await update({ streaming: false });
      assert.equal(container.textContent, before);
      assert.equal(
        container.querySelector('[data-streamdown="strong"]')?.textContent,
        "高置信度：",
      );
    },
  );
});

test("relative links open verified files or stay text; unsafe links stay blocked", async () => {
  const opened = [];
  const reference = {
    text: "docs/plan.md",
    path: "docs/plan.md",
    kind: "file",
  };
  const html = await renderMarkdown(
    { fileReferences: [reference], onOpenFileReference: (r) => opened.push(r) },
    "See [plan](docs/plan.md), [notes](./notes/todo.md), [site](https://example.com/a), [route](/chats/x) and [bad](javascript:alert(1)).",
    async (container) => {
      const button = container.querySelector(".fdy-chat-file-reference");
      assert.equal(button?.textContent, "plan");
      await act(async () => button.click());
    },
  );
  assert.deepEqual(opened, [reference]);
  assert.match(html, /<span title="\.\/notes\/todo\.md">notes<\/span>/);
  assert.doesNotMatch(html, /href="[^"]*(docs\/plan|notes\/todo)/);
  assert.match(
    html,
    /<a target="_blank"[^>]*href="https:\/\/example\.com\/a">site/,
  );
  assert.match(html, /<a target="_blank"[^>]*href="\/chats\/x">route/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(html.match(/\[blocked\]/g)?.length, 1);
});

test("while an answer streams, a relative link is text titled with its target", async () => {
  const html = await renderMarkdown({}, "Read [the plan](docs/plan.md).");
  assert.match(html, /<span title="docs\/plan\.md">the plan<\/span>/);
  assert.doesNotMatch(html, /\[blocked\]/);
});

test("a settled answer is parsed as one document, so later link definitions resolve", async () => {
  const html = await renderMarkdown(
    {},
    "See [the plan][plan] for details.\n\n- first\n- second\n\n[plan]: https://example.com/plan",
  );
  assert.match(
    html,
    /<a [^>]*href="https:\/\/example\.com\/plan"[^>]*>the plan<\/a>/,
  );
  assert.doesNotMatch(html, /\[plan\]/);
  assert.equal(html.match(/<li/g)?.length, 2);
});

async function renderedLinks(props, text) {
  let links = [];
  let body = "";
  await renderMarkdown(props, text, (container) => {
    body = container.textContent;
    links = [...container.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href"),
      text: a.textContent,
    }));
  });
  return { body, links };
}

test("a bare URL ends before Chinese text and full-width punctuation", async () => {
  const doc =
    "https://bytedance.larkoffice.com/docx/CUqLdQeIioltsqxgPbHcmxannzg";
  const message = `正在写文档 ${doc}，还在修订中。得赶紧干完，在尽量在下午能够拉齐一个会议去说这个事情。`;
  for (const props of [{ typedText: true }, {}]) {
    const { body, links } = await renderedLinks(props, message);
    assert.deepEqual(links, [{ href: doc, text: doc }]);
    assert.equal(body, message);
  }
});

test("bare URL boundaries keep GFM rules and valid URLs whole", async () => {
  const cases = [
    ["见 https://a.example/x?q=1&b=2。", "https://a.example/x?q=1&b=2"],
    ["见（https://a.example/p）后续", "https://a.example/p"],
    ["见 (https://a.example/p) 后续", "https://a.example/p"],
    [
      "see https://a.example/wiki/Foo_(bar).",
      "https://a.example/wiki/Foo_(bar)",
    ],
    ["链接 https://a.example/end.", "https://a.example/end"],
    ["链接 https://a.example/end", "https://a.example/end"],
    ["链接 https://a.example/a.，下一句", "https://a.example/a"],
    [
      "编码 https://a.example/%E4%B8%AD%E6%96%87 好",
      "https://a.example/%E4%B8%AD%E6%96%87",
    ],
    ["文档https://a.example/d、另一个", "https://a.example/d"],
    ["前往 www.example.com，然后", "http://www.example.com/"],
  ];
  for (const [text, href] of cases) {
    const { body, links } = await renderedLinks({ typedText: true }, text);
    assert.deepEqual(
      links.map((link) => link.href),
      [href],
      text,
    );
    assert.equal(body, text, text);
  }
});

test("explicit links and text without URLs are left alone", async () => {
  const plain = await renderedLinks({}, "这里没有链接，只有中文。");
  assert.deepEqual(plain.links, []);
  const labelled = await renderedLinks({}, "[文档](https://a.example/d)，后续");
  assert.deepEqual(labelled.links, [
    { href: "https://a.example/d", text: "文档" },
  ]);
});

test("CJK syntax never cuts authored links containing Chinese punctuation", async () => {
  const url = "https://a.example/p。q";
  for (const props of [{ streaming: true }, {}, { typedText: true }]) {
    for (const source of [`[${url}](${url})`, `<${url}>`]) {
      const { body, links } = await renderedLinks(props, source);
      assert.equal(body, url);
      assert.deepEqual(links, [{ href: new URL(url).href, text: url }]);
    }
  }
});
