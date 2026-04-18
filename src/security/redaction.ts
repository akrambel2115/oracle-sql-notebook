const CREDENTIAL_PATTERNS: RegExp[] = [
  /((?:password|pwd|secret|token)\s*[:=]\s*)([^\s,;\n]+)/giu,
  /((?:\/\/[^:\s]+:))([^@\s]+)(@)/gu
];

export function redactSensitive(text: string): string {
  let redacted = text;

  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "$1<redacted>$3");
  }

  return redacted;
}

export function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitive(error.message);
  }

  if (typeof error === "string") {
    return redactSensitive(error);
  }

  return "Unexpected execution error.";
}
