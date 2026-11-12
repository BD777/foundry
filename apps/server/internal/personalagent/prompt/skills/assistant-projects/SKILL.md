---
name: assistant-projects
description: Use before creating, changing, archiving or restoring one of the person's projects, or when create_workspace answers no_place_fits. How to name a project, pass what it needs from a computer, and change only what the person owns.
---

# Creating and changing projects

- Prefer an existing project when the work is genuinely part of it. Create one
  (create_workspace) only for a separate, ongoing effort with its own files: a website, a
  book, a study plan, a research topic, a tool. One-off answers and small notes never need
  one.
- Name it yourself: short, in the person's language, plus a one-sentence purpose and only the
  skills the work obviously needs. Tell them ("I've set up a new project, 『婚礼网站』."). Start
  empty, or clone when they gave you a link to existing code.
- Pass as needs only what the work cannot do without, in the words list_computers shows:
  the company network or an internal site (network:corp, or a reaches:… it lists), their work
  or personal files (files:work), a tool (toolchain:go, toolchain:xcode), a graphics card
  (gpu), staying on day and night (always-on). Self-contained work (a document, a small page,
  a study plan, research) passes none and goes to the default place.
- Foundry picks the computer among those you may use and answers where and why; tell them in
  their words ("on your work computer"). Pick one yourself only if they named it. If its
  reason says the computer's account is shared with someone the person allowed, tell them.
- no_place_fits means nothing was created: ask one plain question naming the need as they
  know it, the computers that might have it, and the one you would pick ("This needs the
  company network. Can your work laptop reach it? I'd use that one."), never the key:value
  words. When they name one, call create_workspace again with its deviceId. If a computer has
  it but you may not create projects there, say they can allow it in your settings, with the
  link.
- Register an existing folder (source kind "existing") only when they pointed you to it.
- update_workspace adds a skill, grants one of their accounts (their Feishu) or renames when
  the purpose changed; mention it in one clause.
- Archive (archive_workspace) only when they say a project is finished or abandoned; restore
  an archived one before handing it work. Never delete projects. Use remove_device only when
  they ask and confirm.
- You change only projects they own. In projects someone shared with them you may hand off
  work but change nothing.

## Examples

Person: "写个小程序，每天早上把公司内部平台上的报警汇总发给我"
You: needs the company network and must keep running: create_workspace with needs
["network:corp", "always-on"].
Reply: "我在你办公室那台电脑上建了个新项目『报警日报』，已经开始做了。"

Person: "plan our two weeks in Japan, day by day"
You: self-contained: create_workspace with no needs.
Reply: "I've set up a new project, “Japan trip”, and started on a day-by-day plan."

Person: "把旧博客那个收起来吧，不做了"
You: archive_workspace answers needs_confirmation.
Reply: "要把『旧博客』收起来吗？里面的东西都会保留，随时能拿回来。点卡片上的按钮就行。"
