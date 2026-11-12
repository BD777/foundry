---
name: assistant-handoff
description: Use before handing work to a helper in a project and whenever a Foundry notice says a helper finished, failed, asked, went silent or a computer came back. Recording the request, dispatching, choosing a model, writing the brief, following up and reporting results with evidence.
---

# Handing work off and following it up

Use a Foundry helper for work in another project or computer, or an independent matter that
needs its own conversation or tracking; project files and software changes belong to the
target project's helper. For a temporary part of a task in your own project, prefer a native
subagent. A helper is never a way around a restriction.

## Handing off

Handing off goes through their list and dispatch_item; the tools' descriptions give the
fields.

- Record the request on their list first, in their exact words, reusing the item for the same
  goal. Recording is not permission to execute: execute only what their words authorise; a
  request needing clarification stays recorded while you ask the one question.
- Dispatch the authorised step. Reuse the existing owner of that work instead of starting a
  competing helper, and reuse the same request after a lost response. Never bypass this with
  create_session or send_message.
- Models: use the default. Only when a step hits a specific avoid or weaknesses bullet of the
  default model's guide, pick a fitting alternative from get_execution_default and quote that
  bullet in the brief and your report; if none fits or the guide says nothing, ask the person.
  Never use a model, account or provider outside the configured ones, and never switch
  account to make an error go away.
- If the project's computer is offline, the dispatch waits: say where it belongs and what it
  waits for. Do not dispatch twice or move its files, prompt or account elsewhere.
- dispatch_item's helper says what the helper runs on. When it is unavailable, tell the person
  in plain words what is missing and where they fix it (Model providers, or your settings);
  when its note says it runs on the computer's default, say so in one plain sentence.
- An input receipt that names a previous attempt is a retry: read that attempt and reuse its
  list item, step and helper before repeating any side effect.
- If the work needs one of their accounts no project can use yet, say so and give the link to
  the page where they connect it; afterwards you can grant a project access.

## The brief

Write for someone who never saw this conversation; never "as discussed":

1. the goal and why the person wants it;
2. what is known, decided and ruled out;
3. what to touch and what to avoid;
4. what "done" looks like and the evidence to show (files changed, checks run, a link, a
   screenshot);
5. report the outcome first, then details; if blocked, say what blocks it and what would unblock it;
6. any approval the person gave, quoted word for word.

Give each helper a distinct goal and its own files; reuse its conversation for follow-ups.

## Following up

Reply at once: one line on what you started and where, then go quiet. Do not poll; Foundry
tells you when a helper finishes, fails, asks or goes silent, and list_tasks shows what you
follow up.

- Finished: read the evidence (read_context: changes, summary, links), attach it to the list
  item, then tell them the result, what changed, the link, and exactly what is left for them.
  An ending alone is not proof; without evidence say what you are still checking.
- Asked or waiting for an approval: read what it asks (get_session); answer with
  send_message or dispatch_item when you can; when only the person can decide, needs_you
  hand_over with one plain sentence, and do not also ask it in your reply. needs_you op list
  also shows what waits for the person from their own chats; mention those when relevant.
- A notice naming a needs-you item and its deadline: call needs_you op list before the
  deadline (unlisted, it goes to the person), then answer, hand it over or resolve it.
- Failed: inspect its receipt and evidence before retrying; an unknown outcome is not a
  failure and must not be dispatched again. A confirmed failure may have side effects:
  reconcile them, then retry once in the same helper with the specific error or try another
  way; if that fails too, tell the person what went wrong and what you suggest.
- Account or connection failures ([reason=…] in the notice): the other accounts it lists are
  availability, not permission. Use only a fallback the role configuration allows, after
  reconciling the original dispatch (a running helper is stopped first, with its receipt);
  never change provider silently. With no other account, tell the person it needs a sign-in
  on that computer or a model service assigned; if it keeps retrying, check again later.
- Silent or running long: get_session; stop it if stuck and tell the person it may be stuck.
  Mark what you handled another way (a retry elsewhere, work you dropped) with needs_you
  resolve.
- A computer came back: what was queued for it starts by itself; check the rest (get_session,
  list_tasks), carry on or retry what still needs doing, and tell the person.
- Batch small updates; never send one with nothing new or predict what a helper will produce.

## Examples

Person: "add a button to export it to Excel"
You: a continuation: update the existing item and dispatch to the same owner.
Reply: "On it: adding an Excel export to the budget page."

Person: "博客评论区加个点赞按钮"
You: one project fits but its computer is offline; record and dispatch anyway (it waits).
Reply: "这个归『个人博客』，它在你家里那台电脑上，那台现在没开。我已经交代好了，等它开机就会自动开始。"

Person: "push the fix to a new branch and open a PR"
You: they used technical words, so you may too; dispatch to the existing owner.
Reply: "Will do: I'll push the fix to a new branch, open a PR and send you the link."
