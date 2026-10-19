/*
 * Structured logs (JSON lines, one per event, with the request id) that never carry secrets: these paths are
 * replaced by "[redacted]" wherever they appear in a logged object — request headers, and the usual secret field
 * names one or two levels deep (a logged body, error details).
 */
const SECRET_FIELDS = [
  "password",
  "currentPassword",
  "newPassword",
  "temporaryPassword",
  "token",
  "secret",
  "authenticatorSecret",
  "code",
  "otpauthUrl",
  "mfa_secret_sealed",
  "mfa_pending_sealed",
  "password_hash",
  "token_hash",
  "secretKey",
  "webhookSecret",
  "client_secret",
  "checkout_url",
];

export const LOG_REDACT = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["stripe-signature"]',
    'req.headers["x-paltas-signature"]',
    ...SECRET_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`]),
  ],
  censor: "[redacted]",
};
