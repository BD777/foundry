type SteerTarget = { runId: string; send: (message: string) => Promise<void> };
const targets = new Map<string, SteerTarget>();

export function registerIssueSteering(
  issueId: string,
  target: SteerTarget,
): () => void {
  targets.set(issueId, target);
  return () => {
    if (targets.get(issueId) === target) targets.delete(issueId);
  };
}

export async function steerIssue(
  issueId: string,
  runId: string,
  message: string,
): Promise<void> {
  const target = targets.get(issueId);
  if (!target || target.runId !== runId)
    throw new Error(
      "This execution is no longer accepting steer input; refresh the Issue.",
    );
  if (!message.trim() || Buffer.byteLength(message) > 32000)
    throw new Error("Steer input must contain 1–32000 bytes.");
  await target.send(message.trim());
}
