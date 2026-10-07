/**
 * restauracao.js — Restauração de backup e prova de integridade.
 *
 * Fluxo:
 *  1. Desfaz as camadas na ordem inversa (ZIP → AES → dump) em diretório
 *     temporário seguro;
 *  2. Inspeciona o dump (pg_restore -l): um arquivo sem tabelas/dados vira
 *     alerta ANTES de restaurar (dump vazio ⇒ banco restaurado em branco);
 *  3. Cria o banco de destino (nunca sobrescreve o original; se existir,
 *     pede confirmação explícita para recriar);
 *  4. pg_restore --no-owner --no-privileges -d <destino>;
 *  5. Integridade genérica: compara o CONJUNTO de tabelas de origem e
 *     restaurado (ausentes/extras contam como divergência), contagem de
 *     linhas e hash determinístico do conteúdo
 *     (md5(string_agg(t::text, ',' ORDER BY t::text)));
 *  6. Apaga temporários ao final.
 *
 * Tudo assíncrono, com progresso via EventEmitter (consumido pelo SSE).
 * Cada evento também é guardado em `this.historico`, para que clientes SSE
 * que conectam depois (janela entre o POST e a abertura do EventSource, ou
 * restauração já concluída) recebam o progresso completo por reenvio.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');

const { mascarar } = require('../lib/mascara');
const pgtools = require('../lib/pgtools');
const cripto = require('./criptografia');

/**
 * Interpreta a saída de `pg_restore -l` (lista de conteúdo do dump).
 * Linhas de comentário começam com ";" e são ignoradas.
 * @returns {{entradas:number, tabelas:number, comDados:number, vazio:boolean}}
 */
function analisarToc(saida) {
  const linhas = String(saida || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith(';'));
  const tabelas = linhas.filter(l => /\bTABLE\b(?! DATA)/.test(l)).length;
  const comDados = linhas.filter(l => /\bTABLE DATA\b/.test(l)).length;
  return { entradas: linhas.length, tabelas, comDados, vazio: linhas.length === 0 };
}

class Restaurador extends EventEmitter {
  /**
   * @param {object} sessao — sessão do servidor
   * @param {object} opts — { arquivo, bancoDestino, bancoOrigem, chaveAes?, senhaZip?, recriarSeExistir, pastaBin }
   */
  constructor(sessao, opts) {
    super();
    this.sessao = sessao;
    this.opts = opts;
    this.segredos = [sessao.senha, opts.chaveAes, opts.senhaZip].filter(Boolean);
    this.tempDir = null;
    this.historico = [];   // eventos emitidos (reenvio a clientes SSE tardios)
    this.alertas = [];     // problemas detectados (dump vazio, tabelas ausentes…)
    this.infoDump = null;
    this.etapaAtual = null;
    this.pgRestore = null;
  }

  /** Emite e registra o evento no histórico (fonte única da trilha SSE). */
  emit(nome, dados) {
    if (nome !== 'newListener' && nome !== 'removeListener') {
      this.historico.push({ nome, dados });
    }
    return super.emit(nome, dados);
  }

  log(nivel, msg) {
    this.emit('log', { nivel, mensagem: mascarar(msg, this.segredos) });
  }

  /** Registra um alerta (aparece na conferência de integridade da tela). */
  alerta(msg) {
    const seguro = mascarar(msg, this.segredos);
    this.alertas.push(seguro);
    this.log('aviso', seguro);
  }

  async executar() {
    const o = this.opts;
    const s = this.sessao;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbac-restore-'));

    try {
      /* ------------------- Desfaz camadas (inverso) ------------------- */
      let arquivo = o.arquivo;

      if (arquivo.endsWith('.zip')) {
        this.etapaAtual = 'zip';
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
        this.etapaAtual = 'aes';
        this.emit('etapa', { etapa: 'aes', estado: 'executando' });
        this.log('info', 'Descriptografando AES-256-GCM…');
        if (!o.chaveAes) throw new Error('Chave AES não informada para descriptografar.');
        const saida = path.join(this.tempDir, 'dump.restaurado');
        await cripto.descriptografarArquivo(arquivo, o.chaveAes, saida);
        arquivo = saida;
        this.emit('etapa', { etapa: 'aes', estado: 'ok' });
      }

      const dumpFinal = arquivo;
      if (!fs.existsSync(dumpFinal)) throw new Error('Arquivo de dump não encontrado após desfazer camadas.');

      /* -------------- Ferramenta + inspeção prévia do dump ------------- */
      // Localiza ANTES de mexer em qualquer banco: se não houver
      // pg_restore, nada é criado nem apagado.
      this.pgRestore = pgtools.localizarFerramenta('pg_restore', o.pastaBin);
      if (!this.pgRestore) throw new Error('pg_restore não encontrado. Informe a pasta bin do PostgreSQL nas Configurações.');
      await this.inspecionarDump(dumpFinal);

      /* --------------------- Cria banco de destino -------------------- */
      this.etapaAtual = 'criar';
      this.emit('etapa', { etapa: 'criar', estado: 'executando' });

      // A sessão não pode manter conexões abertas no destino: elas
      // impediriam o DROP DATABASE ("being accessed by other users").
      if (s.pool && s.banco === o.bancoDestino) {
        await s.pool.end().catch(() => {});
        s.pool = null;
        this.log('aviso', `A sessão estava conectada ao destino "${o.bancoDestino}": conexões da aplicação foram fechadas para recriá-lo.`);
      }

      const poolAdmin = this.criarPool('postgres');
      try {
        const nomeDestino = `"${o.bancoDestino.replace(/"/g, '""')}"`;
        const existe = await poolAdmin.query('SELECT 1 FROM pg_database WHERE datname = $1', [o.bancoDestino]);
        if (existe.rows.length > 0) {
          if (!o.recriarSeExistir) {
            throw new Error(`O banco "${o.bancoDestino}" já existe. Confirme a recriação para sobrescrevê-lo.`);
          }
          this.log('info', `Banco "${o.bancoDestino}" existe e será recriado (drop + create).`);
          await this.derrubarBanco(poolAdmin, nomeDestino);
        }
        await poolAdmin.query(`CREATE DATABASE ${nomeDestino}`);
      } finally {
        await poolAdmin.end().catch(() => {});
      }
      this.emit('etapa', { etapa: 'criar', estado: 'ok' });
      this.log('info', `Banco "${o.bancoDestino}" criado.`);

      /* -------------------------- pg_restore -------------------------- */
      this.etapaAtual = 'restore';
      this.emit('etapa', { etapa: 'restore', estado: 'executando' });
      const args = [
        '--no-owner', '--no-privileges', '--no-password',
        '-h', s.host, '-p', String(s.porta), '-U', s.usuario,
        '-d', o.bancoDestino, dumpFinal,
      ];
      this.log('info', 'Executando pg_restore…');
      await this.spawnMascarado(this.pgRestore.caminho, args, {
        env: { ...process.env, PGPASSWORD: s.senha },
      });
      this.emit('etapa', { etapa: 'restore', estado: 'ok' });
      this.log('info', 'pg_restore concluído.');

      /* ------------------------- Integridade ------------------------- */
      this.etapaAtual = 'integridade';
      this.emit('etapa', { etapa: 'integridade', estado: 'executando' });
      try {
        const resultado = await this.conferirIntegridade(o.bancoOrigem, o.bancoDestino, o.somenteContagem);
        this.emit('integridade', resultado);
      } catch (e) {
        // A restauração funcionou; só a conferência falhou — não faz sentido
        // reportar a restauração inteira como falha.
        const msg = `Restauração concluída, mas a conferência de integridade não pôde ser executada: ${mascarar(e.message, this.segredos)}`;
        this.log('aviso', msg);
        this.emit('integridade', {
          tabelas: [],
          alertas: [msg, ...this.alertas],
          veredito: msg,
          erro: true,
          somenteContagem: !!o.somenteContagem,
        });
      }
      this.emit('etapa', { etapa: 'integridade', estado: 'ok' });

      this.emit('fim', { status: 'sucesso', alertas: this.alertas });
    } catch (e) {
      this.emit('etapa', { etapa: this.etapaAtual || 'restore', estado: 'falha', erro: mascarar(e.message, this.segredos) });
      this.log('erro', `Falha na restauração: ${e.message}`);
      this.emit('fim', { status: 'falha', erro: mascarar(e.message, this.segredos), alertas: this.alertas });
    } finally {
      // Apaga temporários ao final.
      if (this.tempDir) {
        try { fs.rmSync(this.tempDir, { recursive: true, force: true }); } catch { /* já removido */ }
      }
    }
  }

  /** Pool dedicado (a sessão e seus pools nunca são tocados por aqui). */
  criarPool(banco) {
    const s = this.sessao;
    return new Pool({
      host: s.host, port: s.porta, user: s.usuario, password: s.senha,
      database: banco, ssl: s.ssl ? { rejectUnauthorized: false } : false,
      max: 2, connectionTimeoutMillis: 10000,
    });
  }

  /**
   * DROP DATABASE com um plano B: se houver conexões ativas no destino,
   * tenta `WITH (FORCE)` (PostgreSQL 13+) e, se ainda assim falhar, devolve
   * uma mensagem acionável em vez do erro cru do servidor.
   */
  async derrubarBanco(poolAdmin, nomeDestino) {
    try {
      await poolAdmin.query(`DROP DATABASE ${nomeDestino}`);
    } catch (e) {
      if (!/being accessed by other users/i.test(e.message)) throw e;
      try {
        await poolAdmin.query(`DROP DATABASE ${nomeDestino} WITH (FORCE)`);
        this.log('aviso', `Havia conexões ativas no destino; elas foram encerradas (DROP DATABASE … WITH (FORCE)) para recriar o banco.`);
      } catch (e2) {
        throw new Error(
          `Não foi possível recriar o banco: há conexões ativas nele (cliente SQL, outra sessão ou pool da aplicação). ` +
          `Feche essas conexões ou escolha outro nome de destino. Detalhe: ${mascarar(e2.message, this.segredos)}`
        );
      }
    }
  }

  /**
   * Inspeciona o dump com `pg_restore -l` antes de restaurar.
   * Um arquivo sem nenhuma entrada significa backup vazio: o banco
   * restaurado nascerá sem tabelas — isso precisa ficar explícito.
   */
  async inspecionarDump(caminho) {
    try {
      const { stdout } = await this.spawnComSaida(this.pgRestore.caminho, ['-l', caminho]);
      this.infoDump = analisarToc(stdout);
      if (this.infoDump.vazio) {
        this.alerta('O arquivo de backup está vazio (sem tabelas nem dados): a restauração gerará um banco em branco.');
      } else {
        this.log('info', `Conteúdo do backup: ${this.infoDump.tabelas} tabela(s), ${this.infoDump.comDados} com dados copiados.`);
        if (this.infoDump.comDados === 0) {
          this.alerta('O backup contém a estrutura, mas nenhuma tabela com dados copiados.');
        }
      }
    } catch (e) {
      this.log('aviso', `Não foi possível inspecionar o conteúdo do dump: ${mascarar(e.message, this.segredos)}`);
    }
  }

  /**
   * Compara o conjunto de tabelas (origem × restaurado), a contagem de
   * linhas e o hash do conteúdo. Tabela ausente no restaurado ou existente
   * só nele conta como divergência; origem sem tabelas vira alerta — nunca
   * "todas idênticas" por vacuidade.
   */
  async conferirIntegridade(bancoOrigem, bancoDestino, somenteContagem) {
    const poolO = this.criarPool(bancoOrigem);
    const poolD = this.criarPool(bancoDestino);

    const sqlTabelas = `
      SELECT n.nspname AS schema, c.relname AS tabela
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_%'
      ORDER BY 1, 2
    `;

    const chave = (t) => JSON.stringify([t.schema, t.tabela]);

    const contar = async (pool, t) => {
      // Identificadores citados com escape de aspas (vêm do pg_catalog).
      const id = `"${t.schema.replace(/"/g, '""')}"."${t.tabela.replace(/"/g, '""')}"`;
      const cnt = await pool.query(`SELECT count(*)::bigint AS n FROM ${id}`);
      let hash = null;
      if (!somenteContagem) {
        const h = await pool.query(`SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) AS h FROM ${id} t`);
        hash = h.rows[0]?.h || null;
      }
      return { n: Number(cnt.rows[0].n), hash };
    };

    try {
      const [rO, rD] = await Promise.all([poolO.query(sqlTabelas), poolD.query(sqlTabelas)]);
      const mapaO = new Map(rO.rows.map(t => [chave(t), t]));
      const mapaD = new Map(rD.rows.map(t => [chave(t), t]));

      const todos = [
        ...mapaO.values(),
        ...[...mapaD.values()].filter(t => !mapaO.has(chave(t))),
      ].sort((a, b) => `${a.schema}.${a.tabela}`.localeCompare(`${b.schema}.${b.tabela}`));

      const linhas = [];
      for (const t of todos) {
        const temO = mapaO.has(chave(t));
        const temD = mapaD.has(chave(t));
        const o = temO ? await contar(poolO, t) : { n: 0, hash: null };
        const d = temD ? await contar(poolD, t) : { n: 0, hash: null };
        let status;
        if (!temD) status = 'ausente';
        else if (!temO) status = 'extra';
        else if (o.n === d.n && (somenteContagem || o.hash === d.hash)) status = 'identico';
        else status = 'divergente';
        linhas.push({
          tabela: `${t.schema}.${t.tabela}`,
          origem: temO ? o.n : 0,
          restaurado: temD ? d.n : 0,
          hashIgual: somenteContagem || !temO || !temD ? null : (o.hash === d.hash),
          status,
        });
      }

      const divergentes = linhas.filter(l => l.status !== 'identico');
      const ausentes = linhas.filter(l => l.status === 'ausente').length;
      const extras = linhas.filter(l => l.status === 'extra').length;

      const alertas = [...this.alertas];
      if (mapaO.size === 0 && mapaD.size === 0) {
        alertas.push('Nenhuma tabela de usuário na origem nem no restaurado: o backup não contém dados.');
      } else if (mapaO.size === 0) {
        alertas.push('A origem não possui tabelas de usuário — o backup foi gerado de um banco vazio.');
      } else if (mapaD.size === 0) {
        alertas.push('O banco restaurado não contém nenhuma tabela.');
      }
      if (ausentes) alertas.push(`${ausentes} tabela(s) do backup não foram restauradas.`);
      if (extras) alertas.push(`${extras} tabela(s) existem apenas no restaurado (não estão na origem).`);

      let veredito;
      if (linhas.length === 0) {
        veredito = 'Nenhuma tabela de usuário em origem nem no restaurado.';
      } else if (divergentes.length === 0) {
        veredito = 'Todas as tabelas idênticas entre origem e restaurado.';
      } else {
        veredito = `${divergentes.length} tabela(s) divergente(s) entre origem e restaurado (o banco de origem pode ter mudado depois do backup).`;
      }

      return {
        tabelas: linhas,
        veredito,
        alertas,
        resumo: { origem: mapaO.size, restaurado: mapaD.size, divergentes: divergentes.length },
        somenteContagem: !!somenteContagem,
      };
    } finally {
      await poolO.end().catch(() => {});
      await poolD.end().catch(() => {});
    }
  }

  descompactarZip(arquivo, dirSaida, senha) {
    // Usa o módulo próprio (WinZip AES) — portável, sem dependências externas.
    const zipaes = require('./zipaes');
    const buf = fs.readFileSync(arquivo);
    const conteudo = zipaes.descompactarZipAes(buf, senha);
    // Preserva o nome interno do ZIP (".dump" / ".dump.enc"): é ele que indica
    // se ainda há a camada AES a desfazer.
    const nome = zipaes.nomeDaEntrada(buf)
      || (path.basename(arquivo).replace(/\.zip$/i, '') + '.dump');
    fs.writeFileSync(path.join(dirSaida, nome), conteudo);
    return nome;
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

  /** Mesmo que spawnMascarado, mas devolve a saída padrão (usado no -l). */
  spawnComSaida(cmd, args, { env } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { env: env || process.env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`"${path.basename(cmd)}" saiu com código ${code}.${stderr ? ' ' + mascarar(stderr, this.segredos) : ''}`));
      });
    });
  }
}

module.exports = { Restaurador, analisarToc };
