import { createServer } from "node:http";

const body = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
  "<Name>upgrade-canary</Name><Prefix>v1/</Prefix><KeyCount>0</KeyCount>",
  "<MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated>",
  "</ListBucketResult>"
].join("");

createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "application/xml",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}).listen(Number(process.env.R2_STUB_PORT ?? 9000), "127.0.0.1");
