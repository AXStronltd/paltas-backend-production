export const SECURITY_TEMPLATE_KEYS = ["signup.verify", "password.reset"] as const;
/** Security tokens belong in the recipient's email, never in company message-history or export views. */
export function securityMessage(templateKey: unknown) {
  if (templateKey !== "signup.verify" && templateKey !== "password.reset") return null;
  return {
    subject: templateKey === "signup.verify" ? "Verify your PALTAS email" : "Reset your PALTAS password",
    body: "For your security, this link is only shown in the email sent to its recipient.",
    note: "Security email. Check its delivery status for updates.",
  };
}

export function redactSecurityNotification(row: Record<string, unknown>): Record<string, unknown> {
  const safe = securityMessage(row.template_key);
  if (!safe) return row;
  return {
    ...row,
    ...(Object.hasOwn(row, "subject") ? { subject: safe.subject } : {}),
    ...(Object.hasOwn(row, "body") ? { body: safe.body } : {}),
    ...(Object.hasOwn(row, "vars") ? { vars: {} } : {}),
    ...(Object.hasOwn(row, "status_note") ? { status_note: safe.note } : {}),
  };
}
