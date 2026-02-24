#!/usr/bin/env node
import { createPasswordHash } from "../src/security.js";

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run hash-password -- '<strong password>'");
  process.exit(1);
}

try {
  const hash = createPasswordHash(password);
  console.log(hash);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
