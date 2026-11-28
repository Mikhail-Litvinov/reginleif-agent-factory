// Makes the certificates of the TLS proxy (deploy/proxy/envoy.yaml) with node:crypto only: the host has no openssl and the
// package takes no certificate dependency. Three commands, all files written exclusively (an existing file is never
// overwritten: a re-issue is a deliberate remove-then-run) and each private key written only after the file's own access
// was read back (setup-secrets.ts verifyFileAccess, the rule of the secret files):
//
//   node deploy/proxy/certs.ts ca --dir <proxy dir>                                  ca.crt, ca.key
//   node deploy/proxy/certs.ts server --dir <proxy dir> --names <name,name,...>      server.crt, server.key
//   node deploy/proxy/certs.ts worker --dir <proxy dir> --id <worker id> [--out <d>] worker-<id>.crt, worker-<id>.key
//                                                                                    (and ca.crt next to them in --out)
//
// `<proxy dir>` is the proxy folder of the secrets directory (deployment.md, "TLS proxy"). The identity of a worker is the
// URI SAN spiffe://agent-factory/worker/<id>: the proxy's allowlist is written on it (envoy.yaml, security.md S6).
import { X509Certificate, createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join, resolve } from "node:path";
import { restrictDirectory } from "../acl.ts";
import { UsageError, parseCliArgs, reportCliFailure } from "../cli-args.ts";
import { verifyFileAccess } from "../setup-secrets.ts";

// ---- policy ----------------------------------------------------------------------------------------------------------

export const CA_COMMON_NAME = "Agent Factory proxy CA";
// The URI SAN prefix the proxy's worker rule matches (envoy.yaml) and the id alphabet (a DNS-label-like name, 1..63 chars).
export const WORKER_URI_PREFIX = "spiffe://agent-factory/worker/";
const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
// Lifetimes. CA 5 years (1825 days): a private CA that is replaced by hand, so long enough not to be a yearly chore yet
// short enough to be rotated on a hardware cycle. Server 365 days: under the 398-day cap that browsers and the CA/Browser
// Forum Baseline Requirements put on public TLS certificates, the usual yardstick for a server certificate. Worker 90 days:
// the lifetime Let's Encrypt chose for automated certificates; a worker certificate is the credential of a machine, so it is
// kept short and re-issued by the same one command (deployment.md, "Rotation").
export const CA_DAYS = 1825;
export const SERVER_DAYS = 365;
export const WORKER_DAYS = 90;
// notBefore is set this far in the past: the clocks of two machines differ by seconds to minutes (5 minutes is the clock
// skew Kerberos tolerates by default), and a certificate "not yet valid" on the peer would be refused.
const BACKDATE_MS = 5 * 60 * 1000;

// ---- DER -------------------------------------------------------------------------------------------------------------

const lengthOf = (n: number): Buffer => {
	if (n < 0x80) return Buffer.from([n]);
	if (n < 0x100) return Buffer.from([0x81, n]);
	if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff]);
	throw new Error(`DER length ${n} is not supported`);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const octets = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const bitString = (bytes: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.from([unused]), bytes);
const boolTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
const integer = (bytes: Buffer): Buffer => {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
	const magnitude = bytes.subarray(start);
	return tlv(0x02, (magnitude[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), magnitude]) : magnitude);
};
const oid = (dotted: string): Buffer => {
	const arcs = dotted.split(".").map(Number);
	const bytes: number[] = [(arcs[0] as number) * 40 + (arcs[1] as number)];
	for (const arc of arcs.slice(2)) {
		const groups = [arc & 0x7f];
		for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) groups.unshift((rest & 0x7f) | 0x80);
		bytes.push(...groups);
	}
	return tlv(0x06, Buffer.from(bytes));
};
const two = (n: number): string => String(n).padStart(2, "0");
// RFC 5280 4.1.2.5: UTCTime up to the year 2049, GeneralizedTime from 2050.
const time = (date: Date): Buffer => {
	const y = date.getUTCFullYear();
	const rest = `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
	return y < 2050 ? tlv(0x17, Buffer.from(`${two(y % 100)}${rest}`, "ascii")) : tlv(0x18, Buffer.from(`${y}${rest}`, "ascii"));
};

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"; // RFC 5758: ecdsa-with-SHA256, parameters absent
const OID_COMMON_NAME = "2.5.4.3";
const OID_SKI = "2.5.29.14";
const OID_KEY_USAGE = "2.5.29.15";
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_AKI = "2.5.29.35";
const OID_EKU = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

const nameOf = (commonName: string): Buffer => seq(set(seq(oid(OID_COMMON_NAME), utf8(commonName))));
const extension = (id: string, critical: boolean, value: Buffer): Buffer => seq(oid(id), ...(critical ? [boolTrue()] : []), octets(value));

// A key identifier: the first 160 bits of the SHA-256 of the SPKI (a unique value is all RFC 5280 4.2.1.2 asks of it).
const keyIdOf = (spki: Buffer): Buffer => createHash("sha256").update(spki).digest().subarray(0, 20);
const spkiOf = (key: KeyObject): Buffer => createPublicKey(key).export({ type: "spki", format: "der" });

type GeneralName = { readonly kind: "dns" | "uri" | "ip"; readonly value: string };
const generalName = ({ kind, value }: GeneralName): Buffer =>
	kind === "dns" ? tlv(0x82, Buffer.from(value, "ascii")) : kind === "uri" ? tlv(0x86, Buffer.from(value, "ascii")) : tlv(0x87, Buffer.from(value.split(".").map(Number)));

interface Subject {
	readonly commonName: string;
	readonly isCa: boolean;
	readonly usage?: "server" | "client";
	readonly names: readonly GeneralName[];
}

// A signed v3 certificate of `subjectKey`'s public half, issued by `issuer` (a self-signed CA when issuer.key is the subject's own).
const certificate = (subject: Subject, subjectKey: KeyObject, issuer: { readonly commonName: string; readonly key: KeyObject }, notBefore: Date, notAfter: Date): string => {
	const subjectSpki = spkiOf(subjectKey);
	const extensions = [
		extension(OID_BASIC_CONSTRAINTS, true, subject.isCa ? seq(boolTrue(), integer(Buffer.from([0]))) : seq()),
		// CA: keyCertSign (bit 5) + cRLSign (bit 6) = 0x06 with 1 unused bit; leaf: digitalSignature (bit 0) = 0x80 with 7 unused.
		extension(OID_KEY_USAGE, true, subject.isCa ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)),
		...(subject.usage === undefined ? [] : [extension(OID_EKU, false, seq(oid(subject.usage === "server" ? OID_SERVER_AUTH : OID_CLIENT_AUTH)))]),
		...(subject.names.length === 0 ? [] : [extension(OID_SAN, false, seq(...subject.names.map(generalName)))]),
		extension(OID_SKI, false, octets(keyIdOf(subjectSpki))),
		extension(OID_AKI, false, seq(tlv(0x80, keyIdOf(spkiOf(issuer.key))))),
	];
	const serial = randomBytes(16);
	// 16 random bytes with the top bit cleared (a positive INTEGER under the 20-byte limit of RFC 5280 4.1.2.2) and a non-zero first byte (minimal DER).
	serial[0] = ((serial[0] as number) & 0x7f) | 0x01;
	const signatureAlgorithm = seq(oid(OID_ECDSA_SHA256));
	const tbs = seq(
		tlv(0xa0, integer(Buffer.from([2]))), // version [0] EXPLICIT: v3
		integer(serial),
		signatureAlgorithm,
		nameOf(issuer.commonName),
		seq(time(notBefore), time(notAfter)),
		nameOf(subject.commonName),
		subjectSpki,
		tlv(0xa3, seq(...extensions)), // extensions [3] EXPLICIT
	);
	// createSign's default signature encoding is the DER ECDSA-Sig-Value an X.509 signature carries.
	const signature = createSign("sha256").update(tbs).sign(issuer.key);
	return pem("CERTIFICATE", seq(tbs, signatureAlgorithm, bitString(signature)));
};

const pem = (label: string, der: Buffer): string => `-----BEGIN ${label}-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

// ---- issuing ---------------------------------------------------------------------------------------------------------

export interface Issued {
	readonly certPem: string;
	readonly keyPem: string;
}

const newKey = (): KeyObject => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const keyPemOf = (key: KeyObject): string => key.export({ type: "pkcs8", format: "pem" }).toString();

export const issueCa = (now: Date = new Date()): Issued => {
	const key = newKey();
	const certPem = certificate({ commonName: CA_COMMON_NAME, isCa: true, names: [] }, key, { commonName: CA_COMMON_NAME, key }, new Date(now.getTime() - BACKDATE_MS), new Date(now.getTime() + CA_DAYS * DAY_MS));
	return { certPem, keyPem: keyPemOf(key) };
};

// The CA must be valid now and must outlive what it signs: a leaf valid past its CA would fail the chain on that day.
const leafValidity = (ca: Issued, days: number, now: Date): { notBefore: Date; notAfter: Date } => {
	const caCert = new X509Certificate(ca.certPem);
	const notAfter = new Date(now.getTime() + days * DAY_MS);
	if (new Date(caCert.validFrom) > now || new Date(caCert.validTo) < now) throw new Error(`the CA is not valid now (valid ${caCert.validFrom} to ${caCert.validTo}); make a new CA`);
	if (new Date(caCert.validTo) < notAfter) throw new Error(`the CA expires on ${caCert.validTo}, before the ${days}-day certificate would; make a new CA first`);
	return { notBefore: new Date(now.getTime() - BACKDATE_MS), notAfter };
};

const nameKind = (name: string): GeneralName => {
	if (isIPv4(name)) return { kind: "ip", value: name };
	if (/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(name)) return { kind: "dns", value: name };
	throw new UsageError(`${name} is neither a DNS name nor an IPv4 address (IPv6 is not supported)`);
};

// The server certificate of the proxy: `names` are the DNS names and IPv4 addresses a client connects to (the first is the CN).
export const issueServer = (ca: Issued, names: readonly string[], now: Date = new Date()): Issued => {
	if (names.length === 0) throw new UsageError("at least one name is required");
	const key = newKey();
	const { notBefore, notAfter } = leafValidity(ca, SERVER_DAYS, now);
	const certPem = certificate({ commonName: names[0] as string, isCa: false, usage: "server", names: names.map(nameKind) }, key, { commonName: CA_COMMON_NAME, key: createPrivateKey(ca.keyPem) }, notBefore, notAfter);
	return { certPem, keyPem: keyPemOf(key) };
};

export const issueWorker = (ca: Issued, id: string, now: Date = new Date()): Issued => {
	if (!WORKER_ID.test(id)) throw new UsageError(`the worker id ${id} must be 1 to 63 characters of a-z 0-9 and -, starting with a letter or digit`);
	const key = newKey();
	const { notBefore, notAfter } = leafValidity(ca, WORKER_DAYS, now);
	const certPem = certificate({ commonName: `af-worker-${id}`, isCa: false, usage: "client", names: [{ kind: "uri", value: `${WORKER_URI_PREFIX}${id}` }] }, key, { commonName: CA_COMMON_NAME, key: createPrivateKey(ca.keyPem) }, notBefore, notAfter);
	return { certPem, keyPem: keyPemOf(key) };
};

// ---- files -----------------------------------------------------------------------------------------------------------

// Exclusive create; a private key goes in only after the file's own access was read back (the setup-secrets order).
const writeNew = (file: string, text: string, secret: boolean): void => {
	let fd: number;
	try {
		fd = openSync(file, "wx", secret ? 0o600 : 0o644);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists and is not overwritten; remove it to issue again`);
		throw error;
	}
	try {
		if (secret) {
			const problems = verifyFileAccess(file);
			if (problems.length > 0) throw new Error(`the key file ${file} is not restricted as required; nothing was written to it:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
		}
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
};

// A directory that does not exist or is still empty is made and locked to the current user, SYSTEM and Administrators (the
// rule of the secrets directory); one that holds files is left as it is and each key file is verified in it (writeNew).
const prepareDirectory = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	if (readdirSync(dir).length === 0) restrictDirectory(dir, "certificate directory");
};

export const readCa =(dir: string): Issued => {
	const certFile = join(dir, "ca.crt");
	const keyFile = join(dir, "ca.key");
	for (const file of [certFile, keyFile]) if (!existsSync(file)) throw new Error(`${file} is missing; make the CA first (node deploy/proxy/certs.ts ca --dir ${dir})`);
	return { certPem: readFileSync(certFile, "utf8"), keyPem: readFileSync(keyFile, "utf8") };
};

export const writeCa = (dir: string, now: Date = new Date()): string[] => {
	prepareDirectory(dir);
	const ca = issueCa(now);
	// The key first: a certificate without its key is useless, a key without a certificate is harmless.
	writeNew(join(dir, "ca.key"), ca.keyPem, true);
	writeNew(join(dir, "ca.crt"), ca.certPem, false);
	return [join(dir, "ca.crt"), join(dir, "ca.key")];
};

export const writeServer = (dir: string, names: readonly string[], now: Date = new Date()): string[] => {
	const issued = issueServer(readCa(dir), names, now);
	writeNew(join(dir, "server.key"), issued.keyPem, true);
	writeNew(join(dir, "server.crt"), issued.certPem, false);
	return [join(dir, "server.crt"), join(dir, "server.key")];
};

// `out` is where the worker machine's files go (default: the CA directory itself); ca.crt, the public half, is put next to them.
export const writeWorker = (dir: string, id: string, out: string = dir, now: Date = new Date()): string[] => {
	const ca = readCa(dir);
	const issued = issueWorker(ca, id, now);
	prepareDirectory(out);
	writeNew(join(out, `worker-${id}.key`), issued.keyPem, true);
	writeNew(join(out, `worker-${id}.crt`), issued.certPem, false);
	if (!existsSync(join(out, "ca.crt"))) writeNew(join(out, "ca.crt"), ca.certPem, false);
	return [join(out, `worker-${id}.crt`), join(out, `worker-${id}.key`), join(out, "ca.crt")];
};

if (import.meta.main) {
	const usage = [
		"usage: node deploy/proxy/certs.ts ca --dir <proxy dir>",
		"       node deploy/proxy/certs.ts server --dir <proxy dir> --names <name,name,...>",
		"       node deploy/proxy/certs.ts worker --dir <proxy dir> --id <worker id> [--out <directory>]",
	].join("\n");
	try {
		const command = process.argv[2];
		if (command === "ca") {
			const { values } = parseCliArgs(process.argv.slice(3), { flags: { "--dir": "value" }, required: ["--dir"] });
			console.log(`written: ${writeCa(resolve(values["--dir"] as string)).join(", ")}`);
		} else if (command === "server") {
			const { values } = parseCliArgs(process.argv.slice(3), { flags: { "--dir": "value", "--names": "value" }, required: ["--dir", "--names"] });
			console.log(`written: ${writeServer(resolve(values["--dir"] as string), (values["--names"] as string).split(",")).join(", ")}`);
		} else if (command === "worker") {
			const { values } = parseCliArgs(process.argv.slice(3), { flags: { "--dir": "value", "--id": "value", "--out": "value" }, required: ["--dir", "--id"] });
			const dir = resolve(values["--dir"] as string);
			console.log(`written: ${writeWorker(dir, values["--id"] as string, values["--out"] === undefined ? dir : resolve(values["--out"])).join(", ")}`);
		} else throw new UsageError(command === undefined ? "a command is required: ca, server or worker" : `unknown command: ${command}`);
	} catch (error) {
		reportCliFailure(error, "proxy-certs", usage);
	}
}
