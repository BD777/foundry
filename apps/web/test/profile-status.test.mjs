import assert from "node:assert/strict";
import test from "node:test";
import {
  authModeLabel,
  profileBadge,
  promotionBlockReason,
  resolveServerProfileStatus,
  secretsSummaryLabel,
} from "../src/lib/profile-status.ts";

const connectedDevice = {
  id: "device-1",
  label: "Studio",
  lastSeenLabel: "just now",
  status: "connected",
};

const serverProfile = {
  connectionType: "openai_compatible",
  hasCredential: true,
  id: "profile-1",
  label: "Hosted Codex",
  runtime: "codex",
  updatedAtLabel: "2m ago",
};

test("an offline device makes every profile unavailable", () => {
  const resolved = resolveServerProfileStatus({
    device: { ...connectedDevice, status: "disconnected" },
    profile: serverProfile,
    providerHealth: [],
  });

  assert.equal(resolved.status, "unavailable");
  assert.equal(resolved.statusDetail, "Device is offline.");
});

test("an unavailable runtime outranks a stored credential", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    profile: serverProfile,
    providerHealth: [
      {
        authMode: "local_config",
        deviceId: "device-1",
        provider: "codex",
        secretStored: "local",
        status: "unavailable",
        statusDetail: "Codex CLI is not installed.",
      },
    ],
  });

  assert.equal(resolved.status, "unavailable");
  assert.equal(resolved.statusDetail, "Codex CLI is not installed.");
});

// A custom API/gateway profile need not seal a key: an internal proxy can
// authenticate itself. Such a profile is configured and selectable; healthy
// never means verified online, so no health row is required either.
test("a custom profile without a sealed key is still configured", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    profile: { ...serverProfile, hasCredential: false },
    providerHealth: [],
  });

  assert.equal(resolved.status, "healthy");
  assert.equal(resolved.statusDetail, undefined);
});

test("an official profile still gates on the native login", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    profile: {
      ...serverProfile,
      authMode: "official",
      connectionType: "local_login",
      hasCredential: false,
    },
    providerHealth: [],
  });

  assert.equal(resolved.status, "missing_auth");
  assert.equal(resolved.statusDetail, "Authorize this profile on the device.");
});

test("a healthy runtime with a sealed credential is healthy", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    profile: serverProfile,
    providerHealth: [
      {
        authMode: "local_config",
        deviceId: "device-1",
        provider: "codex",
        secretStored: "local",
        status: "healthy",
      },
    ],
  });

  assert.equal(resolved.status, "healthy");
  assert.equal(resolved.statusDetail, undefined);
});

test("the control-plane projection wins over the local preview", () => {
  const resolved = resolveServerProfileStatus({
    device: { ...connectedDevice, status: "disconnected" },
    profile: serverProfile,
    projection: {
      status: "missing_auth",
      statusDetail: "Credential was cleared.",
    },
    providerHealth: [],
  });

  assert.equal(resolved.status, "missing_auth");
  assert.equal(resolved.statusDetail, "Credential was cleared.");
});

test("secrets read Server when only server profiles hold credentials", () => {
  assert.equal(
    secretsSummaryLabel({
      detectedProfiles: [
        { authMode: "missing", id: "detected-1", secretStored: "local" },
      ],
      enabledProfiles: [serverProfile],
    }),
    "Server",
  );
});

test("secrets read Local when only this machine holds credentials", () => {
  assert.equal(
    secretsSummaryLabel({
      detectedProfiles: [
        { authMode: "local_config", id: "detected-1", secretStored: "local" },
      ],
      enabledProfiles: [{ ...serverProfile, hasCredential: false }],
    }),
    "Local",
  );
});

test("secrets read Mixed when both sides hold credentials", () => {
  assert.equal(
    secretsSummaryLabel({
      detectedProfiles: [
        { authMode: "env", id: "detected-1", secretStored: "local" },
      ],
      enabledProfiles: [serverProfile],
    }),
    "Mixed",
  );
});

test("secrets report nothing stored when no credential exists", () => {
  assert.equal(
    secretsSummaryLabel({ detectedProfiles: [], enabledProfiles: [] }),
    "None stored",
  );
});

test("only remote endpoint profiles can be promoted", () => {
  assert.equal(promotionBlockReason("anthropic_compatible"), undefined);
  assert.equal(promotionBlockReason("openai_compatible"), undefined);
  assert.match(promotionBlockReason("local_login"), /never move to the server/);
  assert.match(promotionBlockReason("env"), /environment variable/);
  assert.match(promotionBlockReason("custom_command"), /local command/);
});

test("a local login that never signed in is not described as signed in", () => {
  assert.match(
    promotionBlockReason("local_login", "missing"),
    /^Not signed in yet\./,
  );
  assert.match(
    promotionBlockReason("local_login", "local_config"),
    /^Signed in on this machine\./,
  );
});

test("auth labels stay readable for custom command profiles", () => {
  assert.equal(authModeLabel("local_config"), "Local config");
  assert.equal(authModeLabel("missing"), "Not configured");
});

/**
 * A profile no device may run cannot run at all: the server emits no projection
 * for it, and a session naming it falls back to the daemon's own definition. A
 * sealed credential used to be enough to call that healthy.
 */
test("a profile no device may run is not called healthy", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    deviceProfiles: [],
    profile: serverProfile,
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  assert.notEqual(resolved.status, "healthy");
  assert.equal(resolved.unbound, true);
  assert.match(resolved.statusDetail, /Not enabled on any device/);
});

test("an unbound profile is not blamed on authentication", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    deviceProfiles: [],
    profile: { ...serverProfile, authMode: "official", hasCredential: false },
    providerHealth: [],
  });

  assert.equal(resolved.unbound, true);
  assert.doesNotMatch(resolved.statusDetail, /Authorize/);
  assert.equal(profileBadge(resolved).label, "Not enabled");
});

test("a binding on any device is enough to look past enablement", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    deviceProfiles: [
      { deviceId: "device-other", enabled: true, profileId: serverProfile.id },
    ],
    profile: serverProfile,
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  assert.equal(resolved.status, "healthy");
  assert.equal(resolved.unbound, undefined);
});

test("a disabled binding does not count as enabled", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    deviceProfiles: [
      {
        deviceId: connectedDevice.id,
        enabled: false,
        profileId: serverProfile.id,
      },
    ],
    profile: serverProfile,
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  assert.equal(resolved.unbound, true);
});

/** Callers that know nothing about bindings must keep their old behaviour. */
test("omitting bindings leaves the existing derivation untouched", () => {
  const resolved = resolveServerProfileStatus({
    device: connectedDevice,
    profile: serverProfile,
    providerHealth: [{ provider: "codex", status: "healthy" }],
  });

  assert.equal(resolved.status, "healthy");
  assert.equal(resolved.unbound, undefined);
});

test("a working profile earns no badge, and a broken one says why", () => {
  assert.equal(profileBadge({ status: "healthy" }), undefined);
  assert.deepEqual(profileBadge({ status: "missing_auth" }), {
    label: "Needs auth",
    tone: "warn",
  });
  assert.deepEqual(profileBadge({ status: "unavailable" }), {
    label: "Unavailable",
    tone: "error",
  });
});
