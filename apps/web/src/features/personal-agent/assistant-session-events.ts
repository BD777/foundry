/**
 * The stream events that mean one of the assistant's sessions (or a session
 * doing its work) started or ended: reads that show such state repeat on them.
 */
export const assistantSessionEventTypes = [
  "agent_session_created",
  "agent_session_started",
  "agent_session_blocked",
  "agent_session_resumed",
  "agent_session_completed",
] as const;
