import { BlockList, isIP } from "node:net";
import { AttendanceError, type OfficeNetwork } from "./model";

export function networkRule(cidr: string) {
  const parts = cidr.split("/");
  const ip = parts[0];
  const family = isIP(ip);
  const prefix =
    parts.length === 1 ? (family === 4 ? 32 : 128) : Number(parts[1]);
  if (
    !family ||
    parts.length > 2 ||
    (parts.length === 2 && !/^\d+$/.test(parts[1])) ||
    !Number.isInteger(prefix) ||
    prefix < (family === 4 ? 24 : 48) ||
    prefix > (family === 4 ? 32 : 128)
  ) {
    throw new AttendanceError(
      400,
      "Enter a public office IP or a narrow office prefix (IPv4 /24–/32; IPv6 /48–/128).",
    );
  }
  const privateNetworks = new BlockList();
  for (const [address, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 3],
  ] as const)
    privateNetworks.addSubnet(address, bits, "ipv4");
  privateNetworks.addAddress("::", "ipv6");
  privateNetworks.addAddress("::1", "ipv6");
  privateNetworks.addSubnet("fc00::", 7, "ipv6");
  privateNetworks.addSubnet("fe80::", 10, "ipv6");
  privateNetworks.addSubnet("ff00::", 8, "ipv6");
  const type = family === 4 ? "ipv4" : "ipv6";
  const mapped = new BlockList();
  mapped.addSubnet("::ffff:0:0", 96, "ipv6");
  const globalV6 = new BlockList();
  globalV6.addSubnet("2000::", 3, "ipv6");
  if (
    family === 6 &&
    (mapped.check(ip, "ipv6") ? prefix !== 128 : !globalV6.check(ip, "ipv6"))
  ) {
    throw new AttendanceError(
      400,
      "Use a global IPv6 office prefix, or register this IPv4 connection in IPv4 notation.",
    );
  }
  if (privateNetworks.check(ip, type))
    throw new AttendanceError(
      400,
      "Use the office's public internet address, not a router or private device address.",
    );
  const rule = new BlockList();
  rule.addSubnet(ip, prefix, type);
  return rule;
}

/** Only trust Vercel's ingress-managed header on Vercel, never arbitrary forwarded headers. */
export function clientAddress(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.VERCEL !== "1") return null;
  const address = headers.get("x-vercel-forwarded-for")?.trim();
  return address && isIP(address) ? address : null;
}
export function networkStatus(
  address: string | null,
  networks: OfficeNetwork[],
) {
  const matched =
    address && isIP(address)
      ? networks.find((n) =>
          networkRule(n.cidr).check(
            address,
            isIP(address) === 4 ? "ipv4" : "ipv6",
          ),
        )
      : undefined;
  return { approved: !!matched, label: matched?.label ?? null };
}
