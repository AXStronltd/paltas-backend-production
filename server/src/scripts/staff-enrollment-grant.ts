/** Run only from authenticated hosting administration after independent owner approval.
 * Does not migrate, reset credentials, return existing secrets, or start workers.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Fastify from "fastify";
import { z } from "@paltas/contracts";
import { loadConfig } from "../config.js";
import { connect } from "../db/database.js";
import { systemClock } from "../lib/clock.js";
import { secretBox } from "../lib/secret-box.js";
import { ProductRegistry } from "../products/registry.js";
import { staffEnrollmentService } from "../core/identity/staff-enrollment.js";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    file: { type: "string" },
    approval: { type: "string" },
    "create-first": { type: "boolean" },
    "recover-existing": { type: "boolean" },
    "owner-verified": { type: "boolean" },
  },
  strict: true,
});
if (
  !z.email().safeParse(values.email).success ||
  !values.file ||
  !values.approval ||
  values.approval.trim().length < 12 ||
  !values["owner-verified"] ||
  !!values["create-first"] === !!values["recover-existing"]
) {
  console.error(
    'Usage: staff-enrollment-grant --email <owner> --file <NEW-private-file> --approval "<hosting operator and approval reference>" --owner-verified (--create-first | --recover-existing)',
  );
  process.exit(2);
}
const config = loadConfig(),
  db = connect(config.databaseUrl, 1),
  server = Fastify({ logger: false });
try {
  const service = staffEnrollmentService({
    config,
    db,
    clock: systemClock(),
    secrets: secretBox(config.secretsKey),
    log: server.log,
    products: new ProductRegistry([]),
  });
  const result = await service.issue(
    { email: values.email!, operator: values.approval, createFirst: !!values["create-first"] },
    async (url) => {
      await writeFile(
        values.file!,
        `PALTAS private setup link — expires in 15 minutes.\nOpen privately; mailbox code is sent separately.\n${url}\n`,
        { flag: "wx", mode: 0o600 },
      );
    },
  );
  console.log(
    `Setup link written to the new owner-only file. Mailbox challenge accepted by provider. Expires ${result.expiresAt}. Existing credentials unchanged until confirmation.`,
  );
} catch {
  console.error(
    "Setup authorization was not completed. Check the account, approval, email-provider configuration and that the output file does not exist. No credentials printed.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
  await server.close();
}
