export interface ProtocolEnvelope<T = unknown> {
  error?: string;
  id?: string;
  payload?: T;
  type: string;
}

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const maxProtocolMessageCharacters = 2 * 1024 * 1024;
const maxProtocolIDCharacters = 256;
const maxProtocolErrorCharacters = 8 * 1024;
const protocolTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const envelopeFields = new Set(["error", "id", "payload", "type"]);

export function parseProtocolEnvelopeJSON(text: string): ProtocolEnvelope {
  if (text.length > maxProtocolMessageCharacters) {
    throw new ProtocolValidationError("protocol message exceeds 2 MiB");
  }
  try {
    return parseProtocolEnvelope(JSON.parse(text));
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }
    throw new ProtocolValidationError("protocol message is not valid JSON");
  }
}

export function parseProtocolEnvelope(value: unknown): ProtocolEnvelope {
  if (!isRecord(value)) {
    throw new ProtocolValidationError("protocol envelope must be an object");
  }
  const unknownField = Object.keys(value).find(
    (field) => !envelopeFields.has(field),
  );
  if (unknownField) {
    throw new ProtocolValidationError(
      `protocol envelope contains unknown field ${JSON.stringify(unknownField)}`,
    );
  }

  const type = requiredString(value.type, "type");
  if (!protocolTypePattern.test(type)) {
    throw new ProtocolValidationError(
      "protocol envelope type must match ^[a-z][a-z0-9_]{0,63}$",
    );
  }
  const id = optionalString(value.id, "id", maxProtocolIDCharacters);
  const error = optionalString(
    value.error,
    "error",
    maxProtocolErrorCharacters,
  );

  return {
    ...(error === undefined ? {} : { error }),
    ...(id === undefined ? {} : { id }),
    ...("payload" in value ? { payload: value.payload } : {}),
    type,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolValidationError(
      `protocol envelope ${field} must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProtocolValidationError(
      `protocol envelope ${field} must be a string`,
    );
  }
  if (value.length > maxLength) {
    throw new ProtocolValidationError(
      `protocol envelope ${field} exceeds ${maxLength} characters`,
    );
  }
  return value;
}
