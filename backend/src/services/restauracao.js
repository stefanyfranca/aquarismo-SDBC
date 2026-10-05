/**
 * restauracao.js — Restauração de backup e prova de integridade.
 *
 * Fluxo:
 *  1. Desfaz as camadas na ordem inversa (ZIP → AES → dump) em diretório
 *     temporário seguro;
 *  2. Cria o banco de destino (nunca sobrescreve o original; se existir,
 *     pede confirmação explícita para recriar);
 *  3. pg_restore --no-owner --no-privileges -d <destino>;
 *  4. Integridade genérica: enumera tabelas de usuário (todos os schemas
 *     de usuário) em origem e restaurado; compara contagem de linhas e
 *     hash determinístico do conteúdo (md5(string_agg(t::text, ',' ORDER BY t::text)));
 *  5. Apaga temporários ao final.
 *
 * Tudo assíncrono, com progresso via EventEmitter (consumido pelo SSE).
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { mascarar } = require('./mascara');
const pgtools = require('./pgtools');
const cripto = require('./criptografia');
const conexao = require('./conexao');

class Restaurador extends EventEmitter {
  /**
   * @param {object} sessao — sessão do servidor
   * @param {object} opts — { arquivo, bancoDestino, chaveAes?, senhaZip?, recriarSeExistir, pastaBin }
   */
  constructor(sessao, opts) {
    super();
    this.sessao = sessao;
    this.opts = opts;
    this.segredos = [sessao.senha, opts.chaveAes, opts.senhaZip].filter(Boolean);
    this.tempDir = null;
  }

  log(nivel, msg) {
    this.emit('log', { nivel, mensagem: mascarar(msg, this.segredos) });
  }

  async executar() {
    const o = this.opts;
    const s = this.sessao;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbac-restore-'));
    let dumpFinal = null;

    try {
      /* ------------------- Desfaz camadas (inverso) ------------------- */
      let arquivo = o.arquivo;

      if (arquivo.endsWith('.zip')) {
        this.emit('etapa', { etapa: 'zip', estado: 'executando' });
        this.log('info', 'Descompactando ZIP protegido…');
        const dirZip = path.join(this.tempDir, 'zip');
        fs.mkdirSync(dirZip, { recursive: true });
        await this.descompactarZip(arquivo, dirZip, o.senhaZip);
        const dentro = fs.readdirSync(dirZip).filter(f => !f.endsWith('.zip'));
        if (dentro.length !== 1) throw new Error('ZIP deve conter exatamente um arquivo de backup.');
        arquivo = path.join(dirZip, dentro[0]);
        this.emit('etapa', { etapa: 'zip', estado: 'ok' });
      }

      if (arquivo.endsWith('.enc')) {
        this.emit('etapa', { etapa: 'aes', estado: 'executando' });
        this.log('info', 'Descriptografando AES-256-GCM…');
        if (!o.chaveAes) throw new Error('Chave AES não informada para descriptografar.');
        const saida = path.join(this.tempDir, 'dump.restaurado');
        await cripto.descriptografarArquivo(arquivo, o.chaveAes, saida);
        arquivo = saida;
        this.emit('etapa', { etapa: 'aes', estado: 'ok' });
      }

      dumpFinal = arquivo;
      if (!fs.existsSync(dumpFinal)) throw new Error('Arquivo de dump não encontrado após desfazer camadas.');

      /* --------------------- Cria banco de destino -------------------- */
      this.emit('etapa', { etapa: 'criar', estado: 'executando' });
      const poolAdmin = conexao.conectar(s, 'postgres');
      const existe = await poolAdmin.query('SELECT 1 FROM pg_database WHERE datname = $1', [o.bancoDestino]);
      if (existe.rows.length > 0) {
        if (!o.recriarSeExistir) {
          throw new Error(`O banco "${o.bancoDestino}" já existe. Confirme a recriação para sobrescrevê-lo.`);
        }
        this.log('info', `Banco "${o.bancoDestino}" existe e será recriado (drop + create).`);
        await poolAdmin.query(`DROP DATABASE "${o.bancoDestino.replace(/"/g, '""')}"`);
      }
      await poolAdmin.query(`CREATE DATABASE "${o.bancoDestino.replace(/"/g, '""')}"`);
      this.emit('etapa', { etapa: 'criar', estado: 'ok' });
      this.log('info', `Banco "${o.bancoDestino}" criado.`);

      /* -------------------------- pg_restore -------------------------- */
      this.emit('etapa', { etapa: 'restore', estado: 'executando' });
      const pgRestore = pgtools.localizarFerramenta('pg_restore', o.pastaBin);
      if (!pgRestore) throw new Error('pg_restore não encontrado.');
      const args = [
        '--no-owner', '--no-privileges', '--no-password',
        '-h', s.host, '-p', String(s.porta), '-U', s.usuario,
        '-d', o.bancoDestino, dumpFinal,
      ];
      this.log('info', 'Executando pg_restore…');
      await this.spawnMascarado(pgRestore.caminho, args, {
        env: { ...process.env, PGPASSWORD: s.senha },
      });
      this.emit('etapa', { etapa: 'restore', estado: 'ok' });
      this.log('info', 'pg_restore concluído.');

      /* ------------------------- Integridade ------------------------- */
      this.emit('etapa', { etapa: 'integridade', estado: 'executando' });
      const resultado = await this.conferirIntegridade(o.bancoOrigem, o.bancoDestino, o.somenteContagem);
      this.emit('integridade', resultado);
      this.emit('etapa', { etapa: 'integridade', estado: 'ok' });

      this.emit('fim', { status: 'sucesso' });
    } catch (e) {
      this.emit('etapa', { etapa: this._etapaAtual || 'restore', estado: 'falha', erro: mascarar(e.message, this.segredos) });
      this.log('erro', `Falha na restauração: ${e.message}`);
      this.emit('fim', { status: 'falha', erro: mascarar(e.message, this.segredos) });
    } finally {
      // Apaga temporários ao final.
      if (this.tempDir) {
        try { fs.rmSync(this.tempDir, { recursive: true, force: true }); } catch { /* já removido */ }
      }
    }
  }

  /** Compara contagem e hash do conteúdo de todas as tabelas de usuário. */
  async conferirIntegridade(bancoOrigem, bancoDestino, somenteContagem) {
    // Pools independentes (não usar conexao.conectar, que fecha o pool da sessão).
    const { Pool } = require('pg');
    const mkPool = (banco) => new Pool({
      host: this.sessao.host, port: this.sessao.porta,
      user: this.sessao.usuario, password: this.sessao.senha,
      database: banco, ssl: this.sessao.ssl ? { rejectUnauthorized: false } : false,
      max: 2,
    });
    const poolO = mkPool(bancoOrigem);
    const poolD = mkPool(bancoDestino);

    const sqlTabelas = `
      SELECT n.nspname AS schema, c.relname AS tabela
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_%'
      ORDER BY 1, 2
    `;
    const tabelas = (await poolO.query(sqlTabelas)).rows;
    const linhas = [];

    for (const t of tabelas) {
      // Identificadores citados com escape de aspas (schema/tabela vêm do pg_catalog).
      const id = `"${t.schema.replace(/"/g, '""')}"."${t.tabela.replace(/"/g, '""')}"`;
      const q = async (pool) => {
        const cnt = await pool.query(`SELECT count(*)::bigint AS n FROM ${id}`);
        let hash = null;
        if (!somenteContagem) {
          const h = await pool.query(`SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) AS h FROM ${id} t`);
          hash = h.rows[0]?.h || null;
        }
        return { n: Number(cnt.rows[0].n), hash };
      };
      const o = await q(poolO);
      const d = await q(poolD);
      const identico = o.n === d.n && (somenteContagem || o.hash === d.hash);
      linhas.push({
        tabela: `${t.schema}.${t.tabela}`,
        origem: o.n,
        restaurado: d.n,
        hashIgual: somenteContagem ? null : (o.hash === d.hash),
        status: identico ? 'identico' : 'divergente',
      });
    }

    const todasIdenticas = linhas.every(l => l.status === 'identico');
    await poolO.end().catch(() => {});
    await poolD.end().catch(() => {});
    return {
      tabelas: linhas,
      veredito: todasIdenticas
        ? 'Todas as tabelas idênticas entre origem e restaurado.'
        : 'Há divergências entre origem e restaurado (o banco de origem pode ter mudado depois do backup).',
      somenteContagem: !!somenteContagem,
    };
  }

  descompactarZip(arquivo, dirSaida, senha) {
    // Usa o módulo próprio (WinZip AES) — portável, sem dependências externas.
    const zipaes = require('./zipaes');
    const conteudo = zipaes.descompactarZipAes(fs.readFileSync(arquivo), senha);
    const nome = path.basename(arquivo).replace(/\.zip$/i, '');
    fs.writeFileSync(path.join(dirSaida, nome), conteudo);
  }

  spawnMascarado(cmd, args, { env } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { env: env || process.env, windowsHide: true });
      let stderr = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`"${path.basename(cmd)}" saiu com código ${code}.${stderr ? ' ' + mascarar(stderr, this.segredos) : ''}`));
      });
    });
  }
}

module.exports = { Restaurador };
