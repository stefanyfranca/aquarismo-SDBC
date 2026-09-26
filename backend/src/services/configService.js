const { appPool } = require("../database/pool");

/**
 * Esta tela cuida SÓ das preferências de como o backup é salvo:
 * destino, retenção, cópia adicional, criptografia e compactação.
 * A escolha do banco-alvo (coluna `banco`) é de outra tela da equipe,
 * então esta serviço apenas EDITA a configuração já cadastrada —
 * nunca cria uma nova, porque `banco` é NOT NULL e não chega aqui.
 *
 * A configuração vigente é a mais recente (maior criado_em).
 */

function mapRowToConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    banco: row.banco,
    caminhoDestino: row.caminho_destino,
    quantidadeManter: row.qtd_manter,
    caminhoCopia: row.caminho_copia,
    criptografar: row.criptografar,
    compactar: row.compactar,
    criadoEm: row.criado_em,
  };
}

async function getConfig() {
  const { rows } = await appPool.query(
    `SELECT * FROM configuracoes_backup ORDER BY criado_em DESC, id DESC LIMIT 1`
  );
  return mapRowToConfig(rows[0]);
}

async function saveConfig(input) {
  const { caminhoDestino, quantidadeManter, caminhoCopia, criptografar, compactar } = input;

  if (!caminhoDestino) {
    const err = new Error("O caminho de destino é obrigatório.");
    err.status = 400;
    throw err;
  }

  const existing = await appPool.query(
    `SELECT id FROM configuracoes_backup ORDER BY criado_em DESC, id DESC LIMIT 1`
  );

  if (existing.rows.length === 0) {
    const err = new Error(
      "Nenhuma configuração cadastrada. Crie a primeira configuração na tela de conexão com o banco-alvo."
    );
    err.status = 409;
    throw err;
  }

  const result = await appPool.query(
    `UPDATE configuracoes_backup SET
       caminho_destino = $1, qtd_manter = $2, caminho_copia = $3,
       criptografar = $4, compactar = $5
     WHERE id = $6
     RETURNING *`,
    [caminhoDestino, quantidadeManter || 7, caminhoCopia || null, !!criptografar, !!compactar, existing.rows[0].id]
  );

  return mapRowToConfig(result.rows[0]);
}

module.exports = { getConfig, saveConfig };
