# Foundry built-in skills

Skills Foundry itself gives an agent, beside the ones the agent ships and the
ones a workspace selects. A vendored one is kept unchanged from its source;
update it by replacing the folder. Bump a skill's revision in
`builtinskills.go` whenever its folder changes.

| Folder           | Agent              | Source                                                                                                                          | License                                  |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `skill-creator/` | Claude Code        | https://github.com/anthropics/skills/tree/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/skill-creator                         | Apache-2.0 (`skill-creator/LICENSE.txt`) |
| `foundry/`       | Claude Code, Codex | Foundry (this repository); `packages/worker/skills/foundry/` is the same folder, installed with `foundry skill install foundry` | Apache-2.0                               |
