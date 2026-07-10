import { readFile } from "node:fs/promises";

const expected = "SALVO LEG OK\n";

let actual;
try {
  actual = await readFile(new URL("answer.txt", import.meta.url), "utf8");
} catch (error) {
  console.error(`answer.txt is missing: ${error.message}`);
  process.exit(1);
}

if (actual !== expected) {
  console.error(`unexpected answer.txt contents: ${JSON.stringify(actual)}`);
  process.exit(1);
}

console.log("answer.txt verified");
