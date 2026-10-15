import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets at rest (authenticator secrets) with AES-256-GCM.
 * The key comes from SECRETS_KEY (32 bytes, base64). Stored form: "v1:<iv>:<tag>:<ciphertext>" (base64url parts).
 */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function secretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(
        ":",
      );
    },
    open(sealed) {
      const [v, iv, tag, data] = sealed.split(":");
      if (v !== "v1" || !iv || !tag || !data) throw new Error("Unreadable sealed secret");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
    },
  };
}
