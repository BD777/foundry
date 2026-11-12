import type { ExecutionDefaultsView } from "@bd777/foundry-protocol";
import { request } from "./http";

export interface ExecutionModelChoiceInput {
  providerKind: string;
  providerId: string;
  runtime: string;
  model: string;
  workerGroupId: string;
  effort: string;
}

export interface ExecutionDefaultInput extends ExecutionModelChoiceInput {
  alternatives: ExecutionModelChoiceInput[];
}

const globalPath = "/api/execution-default";
const workspacePath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/execution-default`;

type ExecutionDefaultBody = Partial<ExecutionModelChoiceInput> & {
  alternatives?: Partial<ExecutionModelChoiceInput>[];
};

function executionChoiceBody(
  input: Partial<ExecutionModelChoiceInput>,
): Partial<ExecutionModelChoiceInput> {
  const body: Partial<ExecutionModelChoiceInput> = {};
  for (const field of [
    "providerKind",
    "providerId",
    "runtime",
    "model",
    "workerGroupId",
    "effort",
  ] as const) {
    const value = input[field];
    if (value !== undefined && value !== "") body[field] = value;
  }
  return body;
}

function executionDefaultBody(
  input: Partial<ExecutionDefaultInput>,
): ExecutionDefaultBody {
  const body: ExecutionDefaultBody = executionChoiceBody(input);
  if (input.alternatives !== undefined)
    body.alternatives = input.alternatives.map(executionChoiceBody);
  return body;
}

export function getExecutionDefault(
  workspaceId?: string,
): Promise<ExecutionDefaultsView> {
  return request("GET", workspaceId ? workspacePath(workspaceId) : globalPath);
}

export function setExecutionDefault(
  input: Partial<ExecutionDefaultInput>,
  workspaceId?: string,
): Promise<ExecutionDefaultsView> {
  return request("PUT", workspaceId ? workspacePath(workspaceId) : globalPath, {
    body: executionDefaultBody(input),
  });
}
