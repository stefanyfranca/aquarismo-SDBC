const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY ausente ou inválida no .env (precisa ter 64 caracteres hexadecimais / 32 bytes)."
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Criptografa um texto (ex.: senha do banco-alvo) para guardar em coluna
 * TEXT. Formato salvo: "iv:authTag:conteudoCifrado" (tudo em hex).
 * Nunca logar o valor de entrada nem o resultado.
 */
function encrypt(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Descriptografa um valor gerado por encrypt(). Usado internamente pelo
 * backend (ex.: para executar o backup depois); NUNCA deve ser exposto
 * em uma resposta de API para o frontend.
 */
function decrypt(stored) {
  if (!stored) return null;
  const [ivHex, authTagHex, dataHex] = stored.split(":");
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Formato inválido de valor criptografado.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
