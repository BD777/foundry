# The assistant's own folder

Foundry wrote this file when it set the assistant up (docs/personal-agent.md §2).
This folder is the personal assistant's working space on this computer. The
assistant is the person's single point of contact in Foundry: it decides where
work belongs, hands it to helpers in other projects, follows up and reports.
Its instructions come from Foundry with every conversation; this file only
says what the folder holds.

## What goes where

- `cards/<project id>.md`: routing notes, one per project. When and why the
  person wants work to go there, corrections ("wants X here, not in Y") and
  examples. Start each with front matter naming `updated_at` and what it is
  based on (a decision or conversation id). Foundry's summaries of projects
  live on the server; these notes are what the summaries cannot know.
- `notes/`: small things the assistant does for the person itself: lists,
  drafts, short write-ups that belong to no project.
- `log/YYYY-MM-DD.md`: what was done that day, one short line per thing,
  appended only.
- `.foundry/`: Foundry's own files. Do not edit.

## What never goes here

- Facts about the person and their preferences: those are the assistant's
  memory, kept by Foundry on the server (the `remember` tool), so the person
  can see, correct and truly forget them in the assistant's settings.
- Passwords, keys, codes or any other secret.
- Files, history or decisions of other projects: they stay in their project;
  read them there.
- Copies of conversations or session transcripts.

## Working here

- Keep the folder small and tidy; prefer updating a note to adding a new one.
- Real work (code, documents, research with its own files) belongs in a
  project, not here; create or pick one and hand the work to a helper there.
- This folder may move to another of the person's computers; nothing in it may
  depend on this computer's paths.
