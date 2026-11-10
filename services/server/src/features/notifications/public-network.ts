import { lookup } from "node:dns";
import { BlockList, type LookupFunction } from "node:net";

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("ff00::", 8, "ipv6");
blockedAddresses.addSubnet("2001:db8::", 32, "ipv6");

export const publicHttpsLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, {
    all: true,
    family: options.family,
    hints: options.hints,
    order: "verbatim"
  }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const publicAddresses = addresses.filter(({ address, family }) =>
      isPublicNetworkAddress(address, family)
    );
    if (publicAddresses.length === 0) {
      callback(
        Object.assign(new Error("The destination resolved to a non-public address."), {
          code: "EACCES"
        }),
        []
      );
      return;
    }
    if (options.all) {
      callback(null, publicAddresses);
    } else {
      callback(null, publicAddresses[0].address, publicAddresses[0].family);
    }
  });
};

export function isPublicNetworkAddress(address: string, family: number): boolean {
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}
