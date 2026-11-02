/** A control request may have reached the native process before transport loss. */
export class ControlOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlOutcomeUnknownError";
  }
}
