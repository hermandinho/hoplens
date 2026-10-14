// Typed error class so swallowed exceptions in hot paths have a documented reason, and so
// adapters can discriminate on `err.code` instead of substring-matching messages.

export type HoplensErrorCode =
  | "options-invalid"
  | "ui-port-busy"
  | "ui-bundle-missing"
  | "runtime-already-started"
  | "runtime-blocked-in-production"
  | "discovery-failed"
  | "source-outside-root"
  | "trace-not-found";

export class HoplensError extends Error {
  readonly code: HoplensErrorCode;

  constructor(code: HoplensErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "HoplensError";
    this.code = code;
  }
}
