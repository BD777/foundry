# Personal Agent research: where the assistant and its work run

As of 2026-10-15. Question: on a multi-user Foundry server, where should each person's assistant live and where should the projects it creates go, when real work depends on specific machines (toolchains, corporate network, local files)? **[U]** = unverified (secondary source, or primary pages disagree); everything else was read on a vendor page. A sample, not a complete survey. Companion to [`personal-agent-products.md`](personal-agent-products.md).

## 1. Findings

### Claude (Anthropic): the closest analogue

- **Cloud sessions:** each session runs in "an isolated, Anthropic-managed VM", configured by a saved **cloud environment** (network access, env vars, setup script). The session "keeps running after you close your laptop". The VM clones from GitHub, "not your local checkout". ([cloud](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **Self-hosted environments:** the same sessions run on **runners** inside the customer's network. Runners poll outbound ("Anthropic never connects into your network"). The **user picks** the environment in a picker. A runner "locks to that owner when it claims its first session, so checked-out code never mixes between owners". ([self-hosted](https://code.claude.com/docs/en/self-hosted-environments)).
- **Remote Control:** keeps execution on the person's machine and mirrors the session to phone or web. If the laptop sleeps it reconnects later, but "the local process must keep running" ([remote control](https://code.claude.com/docs/en/remote-control)).
- **Projects** (beta): one **coordinator conversation** starts **threads**, which are "usually a cloud session". "When a task needs something only your computer has, such as a local database, a device emulator, or an API behind your VPN", the person picks **Work locally** and approves an **"Allow Claude to work in a folder on your device"** card. That thread "pauses while that computer is asleep". "A project belongs to one user" ([projects](https://code.claude.com/docs/en/claude-projects)).
- **Cowork / Dispatch:** Cowork "runs your tasks in the cloud" (beta on Team/Enterprise). "Scheduled tasks run in the cloud, with no device online". ([support](https://support.claude.com/articles/13345190)). Dispatch "runs your tasks on your desktop", needs the computer awake, and "isn't available to new users". Users are pointed to cloud sessions instead ([Dispatch](https://support.claude.com/en/articles/13947068)). A reported VM escape ("SharedRoot") in local Cowork and a later cloud default **[U]** ([report](https://letsdatascience.com/news/claude-cowork-sandbox-escape-exposes-mac-files-ac754f6b)).

### ChatGPT (OpenAI)

- **Agent (2025):** ran on "its own virtual computer" ([OpenAI](https://openai.com/index/introducing-chatgpt-agent/), post now marked outdated); sites blocking it was a complaint **[U]** ([forum summary](https://www.elektroda.pl/rtvforum/topic4132276.html)).
- **Work (July 2026):** runs in the cloud on web and mobile, and locally through the desktop app with permission. Local conversations "stay on your computer" **[U]** ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).
- **Cloud task with local access:** "OpenAI's cloud coordinates the task", and a connected computer supplies the files and tools. If the computer is unavailable when a new turn starts, "an existing eligible task can continue in a cloud container without that computer's local files or tools". "A task cannot switch from local execution to the cloud during a turn." ([cloud-local access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access)).
- **Codex remote connections:** threads run on the connected desktop or on an SSH host. "If that computer sleeps … remote access stops." Handing a chat to another host requires a saved project for the same Git repository on that host ([remote connections](https://learn.chatgpt.com/docs/remote-connections)).

### Manus

- Three tiers:
  - **Per-task temporary sandbox** (the environment is not kept).
  - **Cloud Computer:** a persistent 24/7 VM. "Manus will automatically determine that a Cloud Computer is needed" for persistent work ([help](https://help.manus.im/en/articles/15392111-what-is-the-cloud-computer)).
  - **My Computer** (March 2026): local folders the person authorizes. Every terminal command needs approval, and it works only "as long as the machine is on and Manus Desktop is running" ([blog](https://www.manus.im/blog/manus-my-computer-desktop)).

### Google

- **Jules:** each task runs in a "secure, short-lived virtual machine". ([docs](https://jules.google/docs/environment/)).
- **Mariner:** moved from the person's browser to cloud VMs so it could run about 10 tasks in parallel **[U]**. ([coverage](https://www.gigazine.net/gsc_news/en/20250521-project-mariner-google-ai-ultra)).
- **Spark:** "keeps working in the background even when you close your laptop". Local-file access through the macOS app was announced as coming later ([Google](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)).

### Microsoft

- **Windows agent workspace:** "Each agent operates using its own account, distinct from your personal user account", in "a separate Windows session". It gets six known folders; an admin enables it device-wide ([support](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)).
- **Copilot Tasks:** runs on a Microsoft cloud computer and browser **[U]** ([Neowin](https://www.neowin.net/news/microsoft-introduces-copilot-tasks-a-new-way-to-get-things-done-using-ai)).
- **Windows 365 for Agents:** pooled cloud PCs that agents **check out and check in**, managed with Intune and Entra **[U]** ([Help Net](https://www.helpnetsecurity.com/2026/02/24/microsoft-windows-365-for-agents/)).

### Apple Intelligence

- On-device first. Larger requests go to Private Cloud Compute, which is stateless ("personal data leaves no trace"). Devices send data "only to PCC nodes that can cryptographically attest" ([Apple](https://security.apple.com/blog/private-cloud-compute/)). The routing thresholds are not published **[U]** ([analysis](https://www.softwareseni.com/which-apple-ai-workloads-leave-the-device-and-what-they-cost/)).

### OpenClaw and Hermes (self-hosted)

- **OpenClaw topology:** "Run the Gateway on the always-on host (VPS/home server)", with "your laptop as a node". Nodes dial out to the Gateway ([FAQ](https://docs.openclaw.ai/help/faq/remote-gateways-and-nodes.md)).
- **OpenClaw exec host:** `exec` takes `host = auto | sandbox | gateway | node`. The model may pass `host`, but the schema "only lists hosts permitted by the session's host policy". "Node connectivity is checked at execution time" ([exec](https://docs.openclaw.ai/tools/exec)).
- **OpenClaw trust model:** one Gateway is one trust boundary. "Adversarial-user isolation needs separate gateways (and ideally separate OS users/hosts)" ([trust model](https://docs.openclaw.ai/gateway/security/trust-model.md)).
- **OpenClaw community practice:** a VPS for uptime and to keep the agent off the home network, a Mac mini for iMessage, local models and data locality; laptops are test setups **[U]** ([Gizmodo](https://gizmodo.com/best-web-hosting/openclaw/mac-mini-or-vps)). Tailscale is a common glue: a VPS gateway plus a laptop node on one tailnet **[U]** ([guide](https://azdigi.com/en/blog/tri-tue-nhan-tao/openclaw-hybrid-gateway-vps-node-mac-en)).
- **Hermes:** runs on "a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle". You can "talk to it from Telegram while it works on a cloud VM" ([README](https://github.com/NousResearch/hermes-agent)). Where commands run is a configured **terminal backend** (local, docker, ssh, modal, daytona, …). Persistent cloud sandboxes keep files but not "the same live sandbox, PID space, or background processes" ([config](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)).

### Letta, Devin, Cursor, GitHub, Perplexity

- **Letta:** the recommended pattern is **an agent per user**, linked through an Identity. A shared agent means "a single shared message history" ([identities](https://docs.letta.com/guides/agents/multi-user)).
- **Devin:** "Each organization has one active snapshot per platform". Every session "boots a fresh copy", and "session changes don't persist back" ([repo setup](https://docs.devin.ai/onboard-devin/repo-setup)).
- **Cursor:**
  - **My Machines** (one laptop or VM per person) and **Self-Hosted Pools.** The agent loop runs in Cursor's cloud and sends tool calls to a worker over outbound HTTPS ([blog](https://cursor.com/blog/self-hosted-machines)).
  - **Routing:** by `worker=`/`machine=` or `pool=` plus labels. "Requests wait in the pool until an available worker claims them." Each session gets a dedicated worker. Credential-holding workers run one per container or OS user ([pools](https://cursor.com/docs/cloud-agent/self-hosted-pool)).
- **GitHub Copilot cloud agent:** `runs-on` in `copilot-setup-steps.yml` targets ARC self-hosted runners for "internal resources … not available on the public internet". Ephemeral runners are recommended ([changelog](https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-supports-self-hosted-runners), [docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)).
- **Perplexity Personal Computer:** an always-on Mac mini paired with the cloud "Computer" agent. It is reachable from the phone, and approvals happen there **[U]** ([coverage](https://letsdatascience.com/news/perplexity-turns-mac-mini-into-local-ai-agent-83b6fcf8)).
- **Lindy:** cloud-hosted; its computer use is reported slower and flakier than API integrations **[U]** ([review](https://rywalker.com/research/lindy)).

## 2. Patterns

1. **The control plane is always-on; execution sits wherever the resources are.** Claude Projects (coordinator + threads), ChatGPT Work ("moves coordination into OpenAI's cloud. It does not move every tool or file off the computer"), Cursor (cloud loop + workers), OpenClaw (Gateway + laptop nodes). Conversation, memory, schedules and approvals never sleep.

2. **The default place to run is always available. The person's own machine is an explicit opt-in, granted per folder.** Examples: Claude "Work locally" plus the Allow card; Manus folder authorization; ChatGPT local permission; Windows known folders only.
3. **Products that let you move off a laptop push you off it.** Dispatch was closed to new users, who were pointed to the cloud. Cowork's scheduled tasks run in the cloud. OpenClaw advises an always-on host. Mariner moved off the user's browser.
4. **Placement is decided by people and policy; models choose only from a filtered list.** User: Claude's environment picker and Work locally, Codex's host footer. Admin/config: `runs-on`, pools and labels, Hermes backends. Model: OpenClaw's policy-filtered `host`; Manus auto-selects only persistence. I found **no product that reliably infers "this needs the corporate network, so use the laptop"** on its own. Claude leaves that judgment to the person.

5. **Behavior when the machine is offline falls into four types; none move work mid-turn:**
   - Pause and resume: a Claude local thread, Remote Control.
   - Queue until a worker is free: Cursor pools.
   - Continue in the cloud at the **next turn, without the local resources, and say so**: ChatGPT Work.
   - Fail when the command runs: OpenClaw nodes.
6. **Environments are either ephemeral clones of a prepared image or persistent machines, chosen on purpose.** Ephemeral: Devin snapshots, Jules setup scripts, Claude cloud environments, Manus temporary sandboxes. Persistent: Manus Cloud Computer, Hermes `container_persistent` (files only). Persistence never covers running processes across reclaim.
7. **Multi-user separation comes from who owns the execution host, not prompts:** Claude runners lock to one owner; Cursor dedicates workers; OpenClaw needs a Gateway per trust boundary; Letta and Claude Projects are one agent/project per user; Windows uses a separate agent account.
8. **Connections run outbound only, from execution hosts to the control plane.** Claude runners, Cursor workers and OpenClaw nodes all do this. Foundry's Daemon already does too.

## 3. Anti-patterns and complaints

- **Keeping the assistant itself on a laptop.** Dispatch ("computer needs to be awake and the Claude Desktop app open") and Manus My Computer ("as long as the machine is on") both depend on it. Reports describe half-done work when the laptop sleeps **[U]** ([guide](https://www.lowcode.agency/blog/claude-dispatch-explained)); Anthropic closed Dispatch to new users.
- **Several untrusted people sharing one agent or host.** OpenClaw: "Everyone who can message a tool-enabled agent shares that agent's delegated tool authority".
- **Silent fallback that changes what the work can reach.** ChatGPT falls back only at a turn boundary and states what is missing; doing it quietly lets an agent "finish" without the database or VPN it needed.
- **Claiming isolation the product does not have.** Examples: a local VM that mounts the host writable (SharedRoot **[U]**); OpenClaw's "the workspace is not a sandbox".
- **"Works on my laptop" drift in cloud environments.** A cloud VM lacks the VPN, internal DNS and cached credentials a corporate laptop has. Vendors add VPN/egress settings, PrivateLink or Tailscale in the VM ([Cursor](https://cursor.com/docs/cloud-agent/self-hosted), [Codex](https://learn.chatgpt.com/docs/environments/cloud-environments)), or with self-hosted runners. (diagnosis is my inference **[U]**).
- **Relying on uncommitted state to move work between machines.** Teleport needs a pushed branch. Codex handoff needs the same repo on the target host. Cloud thread sandboxes can come back as "a fresh clone, so uncommitted changes can be lost".

## 4. Recommendations for Foundry

Mapping: a Device is a paired Worker; a Workspace is a directory on one device; the Personal Agent is a `personal_agent` Workspace on a home device; new projects are Workspaces under a device's managed root; a hosted container is one more Device. The current design ([`personal-agent.md`](../personal-agent.md) §2) already keeps memory, policy, tasks and proposals on the Server (pattern 1).

**R1. Pick the home by availability, not by how much the person uses it. Add a per-person hosted device as the fallback home.**

Order for picking the home:

1. The device the person chose.
2. A device the person owns whose reports look always-on (desktop or server: high uptime and no sleep gaps).
3. The person's **own hosted container**, if the operator has enabled hosting.
4. A laptop, with today's "offline" reply.

Changes compared with the current design:

- "Most online over 7 days" picks the laptop for many people. Pattern 3 says that is the place people get moved away from.
- If the home is offline and a hosted container exists, the Server starts the assistant's turn there. This happens only at a turn boundary, using the Server-side state, and the reply says the person's own computers are unreachable right now (ChatGPT Work's fallback). The PA notes then exist in two places; make the hosted copy authoritative when one exists. Because model calls go only through the Claude Code / Codex CLI, the assistant always needs some Worker, so "no device" cannot be solved on the Server alone.

**R2. Hosted devices: one per person, owned by that person, never shared.**

- Model them on Claude's runner owner-lock and OpenClaw's gateway-per-trust-boundary rule. Each container gets its own volume, its own CLI logins and connector credentials, and no mounts shared across users.
- It is an ordinary Device the person owns, so ownership, policy, `managedRoots` and the Workspaces page work unchanged. Persistent (a Workspace is a directory), hibernating when idle (Cursor, Daytona), with common toolchains in the base image (Devin, Jules). It is the only way to meet principle 5 for people without computers.
- Open: cost, quota, operator opt-in, and a security review of hosting many people's containers on one Server.

**R3. Place new projects by explicit rules on Server-known facts. The model chooses only from the allowed candidates.**

- The Server computes eligible devices from Worker reports: ownership, online status and uptime, OS/arch, detected toolchains, `managedRoots` and create permission, plus **owner-set labels** (`network: corp`, `files: work-laptop`, `gpu`), set by the owner, not probed (Cursor labels, OpenClaw's filtered schema). `create_workspace` returns the candidates, and the model picks one with a reason.
- Rules, in order:
  - Continuing an existing project goes to **its device, with no fallback**.
  - A request that names local files, a corporate service or a specific toolchain goes only to devices that have it.
  - Work that must stay running (a bot, a monitor) goes to an always-on device or the hosted container.
  - Anything else goes to the always-on choice, in this order: the person's preferred creation device, then hosted, then any allowed device that is online.
- If the rules leave no candidate, the assistant asks a plain-language question ("this needs the company network — shall I use your office desktop?") instead of guessing (pattern 4).

**R4. Pin projects to their device, and handle offline devices visibly.**

- A Workspace never moves silently.
- Requests for a project whose device is offline become a queued task ("waiting for the office desktop") that starts when the device reconnects, as with Cursor pools.
- The assistant may offer (never apply by itself) a git-based copy elsewhere, only when the task needs nothing machine-specific.
- Never switch devices in the middle of a turn (ChatGPT rule).

**R5. Tell the person where work is running, in plain words.**

- Name the device as the person knows it ("on your MacBook", "on the assistant's own computer") with live status (Claude's laptop icon). This keeps principle 3 (no jargon) while making location visible, as every product here does.

**R6. Keep the person's own computers opt-in, per folder.**

- `managedRoots` already acts like Claude's "Allow … folder" card and Manus folder authorization; registering folders outside them stays "ask"; never whole-home access by default (Windows exposes only known folders).

**R7. Cases where these products give no answer:**

- Automatically detecting "needs the corporate network". No product does this reliably, so use labels plus a question.
- Safe multi-person hosting on one Server: products use a VM per session or owner; Foundry's container-vs-VM choice needs its own decision.
- Whether to prefer the hosted device over an always-on personal one: data-locality arguments (Mac mini, Apple on-device-first) say let the person choose.
