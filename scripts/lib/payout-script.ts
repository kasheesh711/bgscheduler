import fs from "node:fs";
import path from "node:path";

export function loadPayoutScriptEnvironment(): void {
  const filePath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/u);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
  }
}

export function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function positionalArguments(optionNames: readonly string[]): string[] {
  const valueIndexes = new Set<number>();
  for (const name of optionNames) {
    const index = process.argv.indexOf(name);
    if (index >= 0) valueIndexes.add(index + 1);
  }
  return process.argv.slice(2).filter((argument, index) =>
    !argument.startsWith("--") && !valueIndexes.has(index + 2));
}

export function writeJsonArtifact(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Create a safety artifact exactly once and flush it before remote writes. */
export function writeJsonArtifactExclusive(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const descriptor = fs.openSync(resolved, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readJsonArtifact<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as T;
}

export function cell(grid: unknown[][], row: number, column: number): unknown {
  return grid[row]?.[column] ?? null;
}

export function formulaCell(grid: unknown[][], label: string): string {
  const value = String(cell(grid, 0, 0) ?? "").trim();
  if (!value.startsWith("=")) throw new Error(`${label} is not a formula.`);
  return value;
}
