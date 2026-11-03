import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isTurnEndLabel,
  parseResponseStreamEventId,
  responseStreamEventId,
  sessionEventLabels,
  sessionInputEventId,
  sessionInputIdOfEvent,
} from "../dist/index.js";

test("response stream ids round-trip their dispatch and ordinal", () => {
  assert.equal(
    responseStreamEventId("sess_a_in_1", 1),
    "evt_sess_a_in_1_response_stream",
  );
  assert.equal(
    responseStreamEventId("sess_a_in_1", 3),
    "evt_sess_a_in_1_response_stream_3",
  );
  for (const ordinal of [1, 2, 12])
    assert.deepEqual(
      parseResponseStreamEventId(responseStreamEventId("sess_a_in_1", ordinal)),
      { dispatchId: "sess_a_in_1", ordinal },
    );
  for (const id of [
    "evt_sess_a_response_stream_final",
    "evt_sess_a_response_stream_0",
    "sess_a_response_stream",
    "evt_in_1",
  ])
    assert.equal(parseResponseStreamEventId(id), undefined, id);
});

test("an input's event id names the input", () => {
  assert.equal(sessionInputEventId("in_1"), "evt_in_1");
  assert.equal(sessionInputIdOfEvent("evt_in_1"), "in_1");
  assert.equal(sessionInputIdOfEvent("evt_"), undefined);
  assert.equal(sessionInputIdOfEvent("read-in_1"), undefined);
});

test("turn-end labels are the ones workers emit", () => {
  for (const label of [
    sessionEventLabels.claudeTurnEnd,
    sessionEventLabels.codexTurnEnd,
    sessionEventLabels.profileCommandTurnEnd,
  ])
    assert.equal(isTurnEndLabel(label), true, label);
  assert.equal(isTurnEndLabel("Codex finished"), true);
  assert.equal(isTurnEndLabel(sessionEventLabels.responseStream), false);
  assert.equal(isTurnEndLabel(undefined), false);
});
