import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import officeAddinDevCerts from "office-addin-dev-certs";

const certificateDirectory = join(homedir(), ".office-addin-dev-certs");
const ca = await readFile(join(certificateDirectory, "ca.crt"), "utf8");
const cert = await readFile(join(certificateDirectory, "localhost.crt"), "utf8");
const key = await readFile(join(certificateDirectory, "localhost.key"), "utf8");

createSecureContext({ ca, cert, key });
const localhostCertificate = new X509Certificate(cert);
const trustedBySystem = officeAddinDevCerts.verifyCertificates();

if (!trustedBySystem) {
  throw new Error("Office 开发 CA 尚未进入 Windows 系统信任库，请运行 npm run certs:install。");
}
if (Date.parse(localhostCertificate.validTo) <= Date.now()) {
  throw new Error("localhost 开发证书已过期，请重新运行 npm run certs:install。");
}
if (!localhostCertificate.checkHost("localhost") || !localhostCertificate.checkIP("127.0.0.1")) {
  throw new Error("localhost 开发证书缺少 localhost 或 127.0.0.1 名称。");
}

console.log(`本地开发证书有效并受系统信任，到期时间：${localhostCertificate.validTo}`);
