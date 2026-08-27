import { readFile, stat } from "node:fs/promises";

export function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error("unexpected positional argument");
    const name = argument.slice(2);
    if (["strict", "apply", "no-persist"].includes(name)) { result[name] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    result[name] = value;
  }
  if (Object.prototype.hasOwnProperty.call(result, "password")) throw new Error("--password is forbidden; use --password-file or BUILDSIM_BACKUP_PASSWORD");
  return result;
}

export async function readPassword(argumentsValue, environment = process.env) {
  if (argumentsValue["password-file"]) {
    if (((await stat(argumentsValue["password-file"])).mode & 0o077) !== 0) throw new Error("backup password file must use 0600-equivalent private permissions");
    return (await readFile(argumentsValue["password-file"], "utf8")).replace(/[\r\n]+$/, "");
  }
  if (environment.BUILDSIM_BACKUP_PASSWORD) return environment.BUILDSIM_BACKUP_PASSWORD;
  throw new Error("backup password is required through --password-file or BUILDSIM_BACKUP_PASSWORD");
}

export function fail(error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "operation failed" })}\n`);
  process.exitCode = 1;
}
