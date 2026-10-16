# Hosted environments and multi-user isolation: how comparable products do it

Date: 2026-10-15. Question: how should one Foundry server serve several people safely? **(a) hosted computers**: a private container or VM per person, registered as one more Device; or **(b) shared device**: several people on one machine with per-person spaces enforced inside one worker. **[unverified]** marks claims backed only by secondary sources.

## Bottom line

- Every product that runs agent code for several parties puts an **owner-level container or VM boundary** between them, usually per session. None separates mutually untrusted people with a sandbox inside one shared agent process or OS user.
- The two products closest to Foundry (an outbound worker executing a cloud control plane's sessions) say so explicitly. Claude Code's self-hosted runner "serves one owner at a time" and locks to that owner [3], and production guidance is a fresh container per session [4]. Cursor: "Co-locating multiple credential-enabled workers under the same user is unsupported. Run one such worker per container or OS user" [7].
- Self-hosted projects agree. OpenClaw supports "one trust boundary per gateway" [27]. OpenHands is "not appropriate for multi-tenant deployments" [12]. GitLab calls the shell executor unsafe [24]. GitHub says self-hosted runners "can be persistently compromised" [23].
- So **(a) is the industry default**. (b) holds up only as one OS user and one worker per person (the JupyterHub Local/Systemd spawner model), and only between people who trust each other. A per-user bubblewrap or Seatbelt space inside one worker is not a tenant boundary.
- Credentials are moving **out of the box**: proxy injection, per-session minted tokens, setup-only secrets. Persistence is converging on **ephemeral compute plus a persistent per-user volume** with an idle stop–archive–delete ladder.

## Per-product findings

### Cloud coding agents

| Product                     | Isolation unit                                                                                                                          | Persists                                                                                         | Environment definition                                     | Credentials and network                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex cloud          | Container per task [1]; VM per task in the 2026 version [2]                                                                             | Cache up to 12 h, **shared across users** in Business/Enterprise [1]; task state 7 days [2]      | `codex-universal` image, setup and maintenance scripts [1] | Secrets **only in the setup phase**. Agent-phase internet off by default, all egress through a proxy [1]. "Network secrets": code sees a placeholder, the proxy injects the real value [2]                          |
| Claude Code on the web      | Isolated sandbox per session [5]                                                                                                        | Transcript (server)                                                                              | Cloud environment + network settings                       | Git credentials "never inside the sandbox". A git proxy checks a scoped credential and the push target, then attaches the real token [5]                                                                            |
| Claude Code self-hosted     | Runner locked to **one owner**; recommended: an ephemeral container or VM per session, no filesystem reuse "never across owners" [3][4] | Per-session config dir and checkout; an end hook is the only chance to save uncommitted work [6] | Runner image, wrapper script, lifecycle hooks [6]          | About 30 min session-scoped inference token, rotated over stdin [6]. Mint other credentials per session. Keep the **environment secret off hosts that run sessions**, block cloud metadata, default-deny egress [4] |
| GitHub Copilot coding agent | Ephemeral Actions runner. Self-hosted only via ARC with "ephemeral, single-use runners" [8]                                             | Nothing                                                                                          | `copilot-setup-steps.yml` [8]                              | Built-in firewall, unavailable on self-hosted or Windows runners [8]                                                                                                                                                |
| Cursor cloud agents         | **Firecracker microVM** per agent, separate AWS account [9]                                                                             | Idle workspace recycled; snapshots deleted after 30 days idle [9]                                | `.cursor/environment.json` (install step snapshotted)      | KMS-encrypted secrets injected as env vars and redacted from transcripts. Three egress modes [9]. Secrets get frozen into snapshots **[unverified, vendor blog]** [10]                                              |
| Cursor self-hosted workers  | One session per worker. Personal "My Machines" vs team pools with a service account [7]                                                 | Nothing unless the pool hibernates                                                               | Your host or image                                         | Session token scoped to one claim; short-lived minted GitHub token [7]                                                                                                                                              |
| Devin                       | New VM per session from the org's single snapshot. DevBox can sit in the customer VPC, connecting out only [11]                         | Snapshot; sessions never write back                                                              | Snapshot or blueprint                                      | Org secrets reach all sessions; repo secrets baked into the snapshot [11]                                                                                                                                           |
| Google Jules                | Short-lived VM per task [13]                                                                                                            | Snapshot after a setup script [14]                                                               | Ubuntu + setup script                                      | Not covered in sources                                                                                                                                                                                              |
| Replit Agent                | Per-Repl container with Nix **[unverified]**                                                                                            | Project, checkpoints                                                                             | `replit.nix`                                               | Jul 2025: the agent deleted a production DB. Fix: **separate dev and prod databases** [15]                                                                                                                          |
| Factory                     | Hosted Droid Computers or **BYOM** (own machine via outbound relay) [16]                                                                | Whole machine                                                                                    | Machine as-is                                              | No BYOM sandbox documented [16]                                                                                                                                                                                     |
| OpenHands                   | Docker sandbox. Enterprise: pod per sandbox, Sysbox, no Docker socket [12][17]                                                          | Workspace mount                                                                                  | Custom image                                               | "Single user", "no built-in authentication, isolation". Weakened by "broad mounts, privileged mode, host networking, or access to the Docker socket" [12]                                                           |

### Dev-environment platforms

- **Coder** [18][19][20]: Terraform templates provision any container, VM or pod.
  - Canonical pattern: **persistent home volume plus ephemeral compute**. Key the volume on an immutable id; a username rename recreates and wipes it.
  - Autostop TTL per template.
  - External provisioners keep cloud and Docker credentials off the server.
  - **External Workspaces** (`coder_external_agent`) bring user-owned machines into the same model, with Start/Stop disabled.
- **Ona (formerly Gitpod)** [21]: runners in Ona's cloud or the customer VPC, `devcontainer.json` plus Automations, environment classes.
- **GitHub Codespaces** [22]:
  - "Two codespaces are never co-located on the same VM", and each has an isolated network.
  - Per-codespace repo-scoped token; secrets withheld from users without write access.
  - 30 min idle timeout; deleted after up to 30 days of retention; dotfiles for personal setup.
- **DevPod** [29]: client-only, with docker, ssh, Kubernetes and VM providers. An inactivity daemon stops the VM or container and keeps its state.
- **Daytona** [30]: auto-stop, auto-archive to object storage, auto-delete, per-sandbox network policy. Kernel-level isolation is not documented.

### Sandbox substrates

| Technology                | Mechanism                                                  | Notes                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firecracker (E2B, Cursor) | KVM microVM, own guest kernel                              | About 125 ms boot **[vendor-cited]**. Needs KVM. E2B pause/resume keeps memory and filesystem [31][32]                                                                                            |
| gVisor (Modal)            | User-space kernel                                          | No nested virtualization needed. Some syscalls unsupported; I/O overhead **[secondary]** [32]                                                                                                     |
| Kata Containers           | OCI runtime over QEMU, Cloud Hypervisor or Firecracker VMs | Kubernetes-native; slower boot [32]                                                                                                                                                               |
| bubblewrap                | Unprivileged user namespaces                               | "not a complete, ready-made sandbox"; protection "entirely determined by the arguments" [33]. Ubuntu 24.04's AppArmor userns restriction breaks bwrap without a profile and has had bypasses [34] |

### Multi-user hosts

- **JupyterHub** [25][26][35]:
  - LocalProcessSpawner gives one Unix user per person, with the hub as root. "Any user may be able to access other users' files" without proper configuration.
  - SystemdSpawner gives each user a unit, optional `DynamicUser`, cgroup memory and CPU limits, private `/tmp`, and read-only paths. Defaults are permissive, and limits "fail silently" without kernel support.
  - DockerSpawner and KubeSpawner give each user a container or pod with a dynamic PVC. The idle culler stops servers but keeps storage.
- **GitHub self-hosted runners** [23][36]: use just-in-time (single-job) runners and runner groups. Secrets passed on the command line "can be seen by another job running on the same runner". The 2024 PyTorch research gained persistence through a non-ephemeral runner.
- **GitLab Runner** [24]: shell executor jobs run as the runner user and can reach other projects' code. Docker is "safe in non-privileged mode"; privileged mode means root on the host.
- **OpenClaw** [27][28]: one gateway per "single operator or a mutually trusting team"; a shared gateway for "mutually untrusted or adversarial users" is unsupported. The per-agent Docker sandbox (no network, capabilities dropped) is not a tenant boundary. The multi-tenant page (one gateway per tenant) returned 404 when fetched **[unverified]**.
- **Hermes Agent** [37][38]: local, Docker, SSH and cloud backends. Profiles separate `HERMES_HOME`, but tools keep the real OS `HOME` and its CLI logins unless `home_mode: profile` is set.

### Incidents

- **Nx "s1ngularity" (Aug 2025)** [39]: malware drove local Claude, Gemini and Q CLIs with `--dangerously-skip-permissions` to steal tokens. A shared `HOME` is the prize.
- **Amazon Q extension (Jul 2025)** [40]: a signed release shipped a prompt to wipe home directories and AWS resources. AWS says it never executed.

## Cross-cutting patterns

1. **The boundary is the owner.** The minimum is one owner per worker or OS user; the best practice is one session per fresh container or VM.
2. **The control plane is separate, and workers dial out.** Claude, Cursor, Devin, Factory and Coder all work this way, and Foundry's worker already does.
3. **Owned and hosted machines share one protocol.** Cursor My Machines vs pools, Coder external vs provisioned, Factory BYOM vs hosted: they differ only in who manages the lifecycle and in routing labels.
4. **Environment = image + setup script + cached snapshot.** `devcontainer.json` is the shared standard.
5. **Compute is ephemeral, the per-user volume persists**, with idle stop (15–30 min), archive (days) and delete (around 30 days).
6. **Credentials stay out of the box.** Mint per session, inject at a proxy, keep registration and provisioner secrets off hosts that run user code, and block cloud metadata. Default-deny egress is the exfiltration control [5].

## Trade-offs

| Option                                                                        | Isolation                                               | Cost / ops               | Fidelity to the real environment | Fit                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------ | -------------------------------- | ------------------------------ |
| bwrap/Seatbelt per session, **one worker and one OS user** for several people | Low: same UID, worker state, device credential, `/proc` | Lowest                   | High                             | Defense in depth for one owner |
| **One OS user and one worker per person** on a shared machine                 | Medium: UID plus cgroup slice, shared kernel            | Low; admin provisioning  | High                             | Trusted team on one box        |
| Container per person, runc                                                    | Medium; one mount or socket mistake breaks it           | Low                      | Medium                           | Trusted team, cheap            |
| Container per person, **gVisor**                                              | Medium-high                                             | Low-medium; syscall gaps | Medium                           | Default hosted computer        |
| **microVM per person** (Kata, Firecracker)                                    | High (own kernel)                                       | Medium; needs KVM        | Medium                           | Mutually untrusted users       |
| Fresh container or VM **per session**                                         | Highest                                                 | Highest; cold starts     | Low-medium                       | Untrusted input                |
| Person's own device (today)                                                   | Physical                                                | None for Foundry         | Highest                          | Primary path                   |

## Anti-patterns

- Several people's credentials or HOMEs under one OS user or one worker [7][27][38].
- Treating an agent sandbox as a tenant boundary [27][33].
- Reusing persistent runners across owners [4][23][36].
- A Docker socket, privileged mode or host network inside a user's box [12][24].
- Secrets baked into images or snapshots [10][11].
- Caches shared across users [1].
- Registration or provisioner secrets on hosts that run user code [4][19].
- A reachable cloud metadata endpoint [4][23].
- Production credentials reachable by the agent [15].
- Per-user storage named by a mutable username [18].
- Silently falling back to unsandboxed execution [34]. Foundry already refuses.

## Recommendations for Foundry's Device/Workspace model

1. **Make (a) the multi-user answer.**
   - A _hosted Device_ is a container running the normal outbound worker, paired to its person as **Device owner**. Use gVisor by default and Kata or Firecracker where KVM exists.
   - Workspaces are folders on its volume. The permission model is unchanged: "Device follows Workspace" and "sharing grants execution as the Device owner" still hold.
   - This matches the existing note that untrusted code needs gVisor or VM isolation (`accounts-permissions-design.md` §3).
2. **One protocol, two lifecycle owners.** Record whether each Device is `owned` or `hosted`.
   - The server starts a hosted Device when a session targets it, stops it after idle time, and archives it after days. The UI shows "asleep", not "offline".
   - Owned Devices get no Start/Stop (the Coder pattern).
   - Hosted workers update by image tag.
3. **Persistence:** one volume per person keyed by user id, ephemeral compute, a Foundry base image, and later `devcontainer.json` and dotfiles. No caches shared across people.
4. **Credentials:**
   - Hosted Devices use the person's own provider login or connections, in the existing resolution order.
   - The provisioner holding Docker or k8s API access never runs user code.
   - Block metadata, mount no Docker socket, and add a default-deny egress allowlist next.
   - Later targets are proxy-injected git and model credentials [2][5].
   - Keep today's sandbox rules: access tokens but no refresh tokens, and transcript redaction.
5. **Constrain (b) to "one OS user and one worker per person".**
   - Each person on a shared machine gets an OS account and their own paired worker (their own Device), in a systemd slice with CPU, memory and task limits. Verify that cgroup delegation actually works.
   - Keep per-session bwrap or Seatbelt as defense in depth. Do **not** build per-person HOMEs and credentials inside one worker.
   - Label this option "trusted team on one machine".
6. **Keep owned devices first-class.** Hosted computers lose real toolchains, internal networks, logged-in CLIs and macOS builds. Route by resources and labels: hosted for people without an always-on machine and for untrusted input, owned for fidelity.
7. **Sequence:**
   - Start with one Linux host: a gVisor container per person, a volume, idle stop and start.
   - Measure cold start, Claude Code and Codex compatibility under gVisor, and idle memory.
   - Move to microVMs only if the threat model requires it.

## Sources

1. Codex cloud environments — https://learn.chatgpt.com/docs/environments/cloud-environment
2. SiliconANGLE 2026-09-29, Codex cloud environments — https://siliconangle.com/2026/09/29/openais-codex-gets-reusable-cloud-environments-that-follow-developers-across-devices/
3. Claude Code self-hosted environments — https://code.claude.com/docs/en/self-hosted-environments
4. Claude Code, deploy (hardening) — https://code.claude.com/docs/en/self-hosted-environments-deploy
5. Anthropic, Claude Code sandboxing — https://www.anthropic.com/engineering/claude-code-sandboxing
6. Claude Code, customize sessions — https://code.claude.com/docs/en/self-hosted-environments-configuration
7. Cursor self-hosted pools — https://cursor.com/docs/cloud-agent/self-hosted-pool
8. Copilot agent environment — https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment
9. Cursor cloud agent security — https://cursor.com/docs/cloud-agent/security
10. Infisical on Cursor secrets — https://infisical.com/blog/secure-secrets-management-for-cursor-cloud-agents
11. Devin VPC — https://docs.devin.ai/enterprise/vpc/overview ; environment — https://docs.devin.ai/onboard-devin/environment ; secrets — https://docs.devin.ai/onboard-devin/secrets
12. OpenHands FAQ — https://docs.openhands.dev/overview/faqs
13. Jules environment — https://jules.google/docs/environment/
14. Jules changelog — https://jules.google/docs/changelog/2025-08-05
15. eWeek, Replit incident — https://www.eweek.com/news/replit-ai-coding-assistant-failure/
16. Factory BYOM — https://docs.factory.ai/droid-computers/byom
17. OpenHands Sysbox — https://docs.openhands.dev/enterprise/k8s-install/sysbox
18. Coder resource persistence — https://coder.com/docs/admin/templates/extending-templates/resource-persistence
19. Coder security / provisioners — https://coder.com/docs/tutorials/best-practices/security-best-practices
20. Coder external workspaces — https://coder.com/docs/admin/templates/managing-templates/external-workspaces
21. Ona core components — https://ona.com/docs/ona/understanding/core-components
22. Codespaces security — https://docs.github.com/en/codespaces/reference/security-in-github-codespaces
23. GitHub Actions hardening — https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
24. GitLab runner security — https://docs.gitlab.com/runner/security
25. JupyterHub concepts — https://jupyterhub.readthedocs.io/en/latest/explanation/concepts.html
26. SystemdSpawner — https://github.com/jupyterhub/systemdspawner
27. OpenClaw trust model — https://docs.openclaw.ai/gateway/security/trust-model
28. OpenClaw sandboxing — https://docs.openclaw.ai/sandboxing
29. DevPod inactivity timeout — https://devpod.sh/docs/developing-in-workspaces/inactivity-timeout
30. Daytona persistence — https://www.daytona.io/docs/en/persistence
31. E2B persistence — https://e2b.dev/docs/sandbox/persistence
32. Fly.io, Firecracker vs gVisor — https://fly.io/learn/firecracker-vs-gvisor/
33. bubblewrap — https://github.com/containers/bubblewrap
34. BleepingComputer, Ubuntu userns bypasses — https://www.bleepingcomputer.com/news/security/new-ubuntu-linux-security-bypasses-require-manual-mitigations/
35. Z2JH user storage — https://zero-to-jupyterhub-k8s.readthedocs.io/user-storage.html
36. SecurityWeek, PyTorch runner attack — https://www.securityweek.com/new-class-of-ci-cd-attacks-could-have-led-to-pytorch-supply-chain-compromise/
37. Hermes tools — https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
38. Hermes profiles — https://hermes-agent.nousresearch.com/docs/user-guide/profiles
39. Wiz, s1ngularity — https://wiz.io/blog/s1ngularity-supply-chain-attack
40. CyberInsider, Amazon Q — https://cyberinsider.com/amazons-ai-coding-assistant-for-vsc-infected-with-data-wiper/
