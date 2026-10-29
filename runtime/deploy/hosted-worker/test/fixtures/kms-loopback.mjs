// Isolated offline KMS HTTP fixture; all key ids/credentials/plaintext are synthetic.
import { createServer } from "node:http";
const arn = "arn:aws:kms:ap-southeast-1:000000000000:key/33333333-3333-4333-8333-333333333333";
let calls = 0;
let invalid = 0;
const server = createServer(async (request, response) => {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 16384) throw Error(); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const escrow = request.url === "/escrow";
    if (request.method !== "POST" || request.headers["x-amz-target"] !== "TrentService.Encrypt"
        || body.KeyId !== arn || body.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT"
        || !request.headers.authorization?.includes("/ap-southeast-1/kms/aws4_request")
        || body.EncryptionContext?.["mdbase:environment"] !== (escrow ? "staging" : "lab")
        || body.EncryptionContext?.["mdbase:service"] !== (escrow ? "next-escrow" : "next-hosted")
        || body.EncryptionContext?.["mdbase:purpose"] !== "device-key"
        || Buffer.from(body.Plaintext, "base64").length !== 96) throw Error();
    calls++;
    response.setHeader("content-type", "application/x-amz-json-1.1");
    response.end(JSON.stringify({ KeyId: arn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", CiphertextBlob: "AQID" }));
  } catch { invalid++; response.statusCode = 400; response.end("{}"); }
});
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("message", () => process.send({ calls, invalid }));
process.on("disconnect", () => { server.closeAllConnections(); server.close(() => process.exit()); });
