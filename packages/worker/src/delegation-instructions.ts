/** Shared choice guidance, not a router or a grant of tool permissions. */
export const delegationInstructions = `Foundry delegation:
- Do small, tightly coupled or context-heavy steps yourself. Delegate only when the independent result is worth the handoff.
- For temporary parts of this task in the same workspace and device, prefer native subagents when the runtime, role, Skill isolation and user authorization allow them.
- Use a Foundry session for work across workspaces, devices or providers, or an independent matter needing its own user chat, ongoing tracking or explicitly different execution environment. Honor the user's explicit choice of mechanism. A different model alone does not require Foundry if native tools support the requested configuration.
- Reuse the session already responsible for the matter with send_message; use handoff_session when its history would mislead the continuation. For a remote command alone, use an available compute lease.
- If native delegation is restricted, do small work yourself. A Foundry child is not a workaround: any necessary child or Skill trial must preserve the locked Skill and permission constraints.
- Before delegating, state the purpose and expected result briefly. Give each delegate a distinct scope and file ownership; avoid duplicate goals, unnecessary nesting and stage reports. Return results and necessary evidence, not private reasoning.`;
