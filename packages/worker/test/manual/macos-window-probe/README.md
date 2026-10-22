# macOS scoped-window hardware probe

This is a manual hardware fixture, not a production input helper. It creates only
`app.foundry.dev028.probe`, without activating it, and operates its synthetic
controls through the current Foundry provider and the already installed CuaDriver.

Before running, hold both the device's compute and computer_use leases. The console
must be unlocked and CuaDriver must already report Accessibility and Screen
Recording grants. The runner refuses before App launch if the console is locked,
and never starts the driver, requests permissions or escalates to foreground.

Prepare in a dedicated scratch directory, not in the fixture source directory:

1. Copy `probe.swift`, `run-probe.mjs` and `Info.plist` into it.
2. Bundle the current `packages/worker/src/resources/providers/cua-driver.ts` using
   the repository's installed esbuild: `--bundle --platform=node --format=esm
--outfile=<scratch>/dev028-provider.mjs`. Do not reuse an older bundle.
3. Make `Dev028Probe.app/Contents/MacOS/`, place `Info.plist` under `Contents`, then
   on the target Mac run `swiftc probe.swift -o Dev028Probe.app/Contents/MacOS/probe`.
4. Set `DEV028_DRIVER` to the installed driver's absolute path, `DO_NOT_TRACK=1`
   and `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`; run `node run-probe.mjs` there.
5. Read `proof.json` even when the process exits nonzero. Verify the fixture exited,
   then release both leases and retain their release receipts.

A separate bounded sampler starts before the synthetic App (up to 10s cold-start
wait). It samples the pointer, frontmost app, read-only WindowServer keyboard-focus
PID and clipboard change count every 10ms; it never reads clipboard contents.
Input stops if any sampled global state changes, including unrelated human activity.
The App's own counter, field value and scroll position show whether actions applied.
The window screenshot, if produced, contains only the synthetic App.

A check that cannot read keyboard focus is not proof that focus was preserved.
Samples cannot rule out shorter transients. This fixture does not simulate a person
concurrently typing in another foreground App; that remains a separate acceptance
step. Permission status, selection success, backend transport success and confirmed
UI effect must be reported separately.

Recorded status: the fixture compiled and launched on macOS 26.5.2 / CuaDriver
0.34.0, but the console was locked and the driver returned an unresolved AX window.
No positive input result has been accepted. The current preflight prevents repeating
that locked-console App launch. Bare executable launch has no reliable AppKit launch
identity here; the fixture uses `open -g -n` only for its own synthetic App.

On the unlocked MacBook, the first 2s cold-start deadline was too short and refused
App launch. A subsequent read-only sample saw global state changes while the person
was using the device; their cause was not attributable. No input was sent. A short
interval without pointer movement or foreground-app switching is needed for the
baseline interference check; concurrent human use remains a distinct test.
