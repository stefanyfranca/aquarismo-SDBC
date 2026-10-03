/**
 * pipeline.js — Orquestração das 8 etapas da execução de backup.
 *
 * Etapas:
 *  1. Validação    — conexão, permissões, parâmetros, ferramentas, diretórios, espaço
 *  2. Manutenção   — decisão, registro e execução (VACUUM / VACUUM FULL ANALYZE)
 *  3. Backup       — pg_dump -Fc (senha via PGPASSWORD no env do processo filho)
 *  4. Criptografia — AES-256-GCM (opcional)
 *  5. Compactação  — ZIP protegido por senha (opcional)
 *  6. Retenção     — mantém os N mais recentes (opcional)
 *  7. Cópia        — copia e verifica hash SHA-256 (opcional)
 *  8. Finalização  — resultado, duração, limpeza de temporários
 *
 * Cada etapa: marca "executando", loga início/fim, marca ok/pulada/falha.
 * Ao falhar, as etapas seguintes são marcadas como "pulada".
 * Toda saída técnica passa pelo filtro de máscara de segredos.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');
const { mascarar } = require('./mascara');
const v = require('./validacao');
const pgtools = require('./pgtools');
const conexao = require('./conexao');
const retencao = require('./retencao');
const cripto = require('./criptografia');
const email = require('./email');

const ETAPAS = [
  'validacao', 'manutencao', 'backup', 'criptografia',
  'compactacao', 'retencao', 'copia', 'finalizacao',
];

const ETAPAS_BLOQUEANTES = new Set(['VACUUM_FULL_ANALYZE']);

class Executor extends EventEmitter {
  /**
   * @param {object} sessao — sessão do servidor (contém a senha em memória)
   * @param {object} params — parâmetros da execução
   * @param {object} decisao — decisão de manutenção (manutencao.decidir)
   */
  constructor(sessao, params, decisao) {
    super();
    this.sessao = sessao;
    this.params = params;
    this.decisao = decisao;
    this.segredos = [sessao.senha, params.chaveAes, params.senhaZip].filter(Boolean);
    this.execucaoId = null;
    this.etapaAtual = null;
    this.arquivoAtual = null;   // arquivo em produção (dump → enc → zip)
    this.temporarios = [];      // arquivos a remover ao final
    this.inicio = null;
    this.falha = null;
  }

  /* ------------------------------ logging ------------------------------ */

  log(nivel, etapa, mensagem, { tecnica = null } = {}) {
    const entrada = {
      execucao_id: this.execucaoId,
      data: new Date().toISOString(),
      etapa: etapa || this.etapaAtual || 'geral',
      nivel,
      mensagem: tecnica ? `${mensagem} | saída: ${mascarar(tecnica, this.segredos)}` : mascarar(mensagem, this.segredos),
    };
    db.inserirLog(entrada);
    this.emit('log', entrada);
  }

  /* ------------------------------ etapas ------------------------------- */

  async executarEtapa(nome, fn) {
    this.etapaAtual = nome;
    this.emit('etapa', { etapa: nome, estado: 'executando' });
    this.log('info', nome, `Etapa "${nome}" iniciada.`);
    const t0 = Date.now();
    try {
      await fn();
      this.emit('etapa', { etapa: nome, estado: 'ok' });
      this.log('info', nome, `Etapa "${nome}" concluída em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      return true;
    } catch (e) {
      const msg = mascarar(e.message, this.segredos);
      this.emit('etapa', { etapa: nome, estado: 'falha', erro: msg });
      this.log('erro', nome, `Etapa "${nome}" FALHOU: ${msg}`);
      this.falha = { etapa: nome, erro: msg };
      // Marca etapas seguintes como puladas.
      const idx = ETAPAS.indexOf(nome);
      for (const prox of ETAPAS.slice(idx + 1)) {
        this.emit('etapa', { etapa: prox, estado: 'pulada' });
      }
      return false;
    }
  }

  pularEtapa(nome, motivo) {
    this.emit('etapa', { etapa: nome, estado: 'pulada' });
    this.log('aviso', nome, `Etapa "${nome}" pulada: ${motivo}`);
  }

  /* --------------------------- execução principal ----------------------- */

  async executar() {
    this.inicio = new Date().toISOString();
    const p = this.params;
    const chaveConexao = `${this.sessao.host}:${this.sessao.porta}/${p.banco}`;
    let eventoFim = { status: 'falha' };

    // Registro da execução no armazenamento local.
    this.execucaoId = db.inserirExecucao({
      chave_conexao: chaveConexao,
      inicio: this.inicio,
      status: 'andamento',
      manutencao_tipo: this.decisao.tipo,
      regra_aplicada: this.decisao.regra,
      origem_decisao: this.decisao.origem,
      parametros: {
        banco: p.banco,
        destino: p.destino,
        quantidade_manter: p.quantidadeManter ?? null,
        copia_adicional: p.copiaAdicional || null,
        compactar: !!p.compactar,
        criptografar: !!p.criptografar,
        manutencao_escolha: p.escolhaManutencao || 'AUTOMATICA',
        demo: !!p.demoDataSimulada,
      },
    });
    this.emit('inicio', { id: this.execucaoId });
    this.log('info', 'geral', `Execução #${this.execucaoId} iniciada para ${chaveConexao}. Decisão: ${this.decisao.regra}`);

    try {
      /* ------------------------- 1. Validação ------------------------- */
      const ok1 = await this.executarEtapa('validacao', () => this.etapaValidacao());
      if (!ok1) throw new Error('validacao');

      /* ------------------------- 2. Manutenção ------------------------ */
      if (this.decisao.tipo === 'NENHUMA') {
        this.pularEtapa('manutencao', `Decisão: ${this.decisao.regra}`);
      } else {
        const ok2 = await this.executarEtapa('manutencao', () => this.etapaManutencao());
        if (!ok2) throw new Error('manutencao');
      }

      /* -------------------------- 3. Backup --------------------------- */
      const ok3 = await this.executarEtapa('backup', () => this.etapaBackup());
      if (!ok3) throw new Error('backup');

      /* ----------------------- 4. Criptografia ----------------------- */
      if (!p.criptografar) {
        this.pularEtapa('criptografia', 'Opção desabilitada.');
      } else {
        const ok4 = await this.executarEtapa('criptografia', () => this.etapaCriptografia());
        if (!ok4) throw new Error('criptografia');
      }

      /* ----------------------- 5. Compactação ------------------------ */
      if (!p.compactar) {
        this.pularEtapa('compactacao', 'Opção desabilitada.');
      } else {
        const ok5 = await this.executarEtapa('compactacao', () => this.etapaCompactacao());
        if (!ok5) throw new Error('compactacao');
      }

      /* ------------------------- 6. Retenção ------------------------- */
      if (!p.quantidadeManter || p.quantidadeManter < 1) {
        this.pularEtapa('retencao', 'Quantidade a manter não informada.');
      } else {
        const ok6 = await this.executarEtapa('retencao', () => this.etapaRetencao());
        if (!ok6) throw new Error('retencao');
      }

      /* -------------------------- 7. Cópia --------------------------- */
      if (!p.copiaAdicional) {
        this.pularEtapa('copia', 'Caminho de cópia adicional não informado.');
      } else {
        const ok7 = await this.executarEtapa('copia', () => this.etapaCopia());
        if (!ok7) throw new Error('copia');
      }

      /* ----------------------- 8. Finalização ----------------------- */
      await this.executarEtapa('finalizacao', () => this.etapaFinalizacao(true));

      db.atualizarExecucao(this.execucaoId, {
        status: 'sucesso',
        fim: new Date().toISOString(),
        resultado: `Backup concluído: ${this.arquivoAtual}`,
        arquivo_final: this.arquivoAtual,
      });
      eventoFim = { status: 'sucesso' };
      this.log('info', 'geral', `Execução #${this.execucaoId} concluída com sucesso.`);
    } catch (e) {
      // Falha: preserva log, tenta apagar arquivo parcial, envia e-mail.
      const etapaFalha = this.falha?.etapa || 'desconhecida';
      db.atualizarExecucao(this.execucaoId, {
        status: 'falha',
        fim: new Date().toISOString(),
        etapa_falha: etapaFalha,
        resultado: this.falha?.erro || 'Falha desconhecida.',
      });
      eventoFim = { status: 'falha', etapa: etapaFalha };
      this.log('erro', 'geral', `Execução #${this.execucaoId} FALHOU na etapa "${etapaFalha}".`);

      // Tenta apagar arquivo parcial.
      if (this.arquivoAtual) {
        try { fs.unlinkSync(this.arquivoAtual); } catch { /* já removido */ }
      }
    } finally {
      // Limpa temporários (em sucesso e em falha).
      for (const t of this.temporarios) {
        try { fs.unlinkSync(t); } catch { /* já removido */ }
      }
      // E-mail (envio ou simulação comprovável).
      try {
        const exec = db.buscarExecucao(this.execucaoId);
        const logs = db.logsDaExecucao(this.execucaoId);
        const cfg = db.getConfiguracao(exec.chave_conexao) || {};
        const r = await email.enviarEmailExecucao({ execucao: exec, logs, configuracao: cfg });
        this.log('info', 'geral', r.enviado
          ? `E-mail enviado para ${cfg.email_alerta}.`
          : `E-mail SIMULADO (gravado em ./data/outbox/): ${r.motivo}`);
      } catch (e) {
        this.log('aviso', 'geral', `Não foi possível enviar o e-mail: ${mascarar(e.message, this.segredos)}`);
      }
      this.emit('fim', eventoFim);
    }
  }

  /* ----------------------------- etapa 1 ------------------------------- */

  async etapaValidacao() {
    const p = this.params;
    const s = this.sessao;

    // Nomes e porta.
    const errs = [
      v.validarHost(s.host), v.validarPorta(s.porta), v.validarUsuario(s.usuario),
      v.validarBanco(p.banco),
    ].filter(Boolean);
    if (errs.length) throw new Error(`Validação: ${errs.join(' ')}`);

    // Diretórios.
    const erroDestino = v.validarCaminho(p.destino, { rotulo: 'Destino do backup' });
    if (erroDestino) throw new Error(erroDestino);
    if (p.copiaAdicional) {
      const erroCopia = v.validarCaminho(p.copiaAdicional, { rotulo: 'Caminho de cópia adicional' });
      if (erroCopia) throw new Error(erroCopia);
      if (path.resolve(p.copiaAdicional) === path.resolve(p.destino)) {
        throw new Error('Destino e cópia adicional não podem ser o mesmo diretório.');
      }
    }

    // Ferramentas do PostgreSQL.
    const ferramentas = pgtools.localizarTodas(p.pastaBin);
    if (!ferramentas.pg_dump) throw new Error('pg_dump não encontrado. Informe a pasta bin do PostgreSQL nas Configurações.');
    if (!ferramentas.pg_restore) throw new Error('pg_restore não encontrado. Informe a pasta bin do PostgreSQL nas Configurações.');
    this.ferramentas = ferramentas;

    // Conexão real (SELECT 1) + versão do servidor.
    const pool = conexao.conectar(s, p.banco);
    const r = await pool.query('SHOW server_version');
    this.versaoServidor = r.rows[0].server_version;
    const compat = pgtools.verificarCompatibilidade(ferramentas.pg_dump.versao, this.versaoServidor);
    if (!compat.ok) throw new Error(compat.erro);
    if (compat.aviso) this.log('aviso', 'validacao', compat.aviso);

    // Permissões (só falha se manutenção for necessária).
    const perm = await conexao.verificarPermissoes(s);
    this.permissoes = perm;
    if (this.decisao.tipo !== 'NENHUMA' && !perm.podeManter) {
      throw new Error(`Permissão negada: ${perm.erros.join(' ')}`);
    }
    if (perm.erros.length) {
      this.log('aviso', 'validacao', perm.erros.join(' '));
    }

    // Diretórios graváveis + espaço.
    const erroGrav = await v.verificarDiretorioGravavel(p.destino);
    if (erroGrav) throw new Error(erroGrav);
    if (p.copiaAdicional) {
      const erroGrav2 = await v.verificarDiretorioGravavel(p.copiaAdicional);
      if (erroGrav2) throw new Error(erroGrav2);
    }
    const erroEspaco = await v.verificarEspacoLivre(p.destino);
    if (erroEspaco) throw new Error(erroEspaco);

    // Segredos exigidos presentes.
    if (p.criptografar && (!p.chaveAes || p.chaveAes.length < 8)) {
      throw new Error('Criptografia habilitada: informe a chave AES (mínimo 8 caracteres).');
    }
    if (p.compactar && (!p.senhaZip || p.senhaZip.length < 8)) {
      throw new Error('Compactação habilitada: informe a senha do ZIP (mínimo 8 caracteres).');
    }

    // Falha controlada (modo demonstração).
    if (p.simularFalha) {
      this.log('aviso', 'validacao', 'MODO DEMONSTRAÇÃO: falha controlada será simulada na etapa de backup.');
    }
  }

  /* ----------------------------- etapa 2 ------------------------------- */

  async etapaManutencao() {
    const s = this.sessao;
    const tipo = this.decisao.tipo;
    const inicio = new Date().toISOString();

    // Registro local da manutenção (fonte A).
    const manId = db.inserirManutencao({
      chave_conexao: `${s.host}:${s.porta}/${this.params.banco}`,
      tipo, inicio, fim: null, execucao_id: this.execucaoId,
    });

    // Conexão dedicada, FORA de transação (VACUUM não roda em bloco de transação).
    const pool = conexao.conectar(s, this.params.banco);
    const client = await pool.connect();
    try {
      if (tipo === 'VACUUM') {
        this.log('info', 'manutencao', 'Executando VACUUM (banco inteiro, fora de transação)…');
        await client.query('VACUUM');
      } else {
        this.log('info', 'manutencao', 'Executando VACUUM FULL ANALYZE (banco inteiro, fora de transação)…');
        await client.query('VACUUM FULL ANALYZE');
      }
    } finally {
      client.release();
    }
    const fim = new Date().toISOString();
    db.get().prepare('UPDATE manutencoes SET fim = ? WHERE id = ?').run(fim, manId);
    this.log('info', 'manutencao', `${tipo} concluído.`);
  }

  /* ----------------------------- etapa 3 ------------------------------- */

  async etapaBackup() {
    const p = this.params;
    const s = this.sessao;

    // Falha controlada (modo demonstração).
    if (p.simularFalha) {
      throw new Error('Falha controlada simulada (modo demonstração) na etapa de backup.');
    }

    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const nomeArquivo = `backup-${p.banco}-${ts}.dump`;
    const destino = path.join(path.resolve(p.destino), nomeArquivo);
    this.arquivoAtual = destino;
    // NÃO adicionar aos temporários aqui: o dump pode ser o arquivo final.

    const args = [
      '-Fc', '--no-password',
      '-h', s.host, '-p', String(s.porta), '-U', s.usuario,
      '-d', p.banco, '-f', destino,
    ];

    this.log('info', 'backup', `Iniciando pg_dump -Fc para ${destino}`);
    await this.spawnMascarado(this.ferramentas.pg_dump.caminho, args, {
      env: { ...process.env, PGPASSWORD: s.senha }, // senha via env, NUNCA em argumentos
    });
    const st = fs.statSync(destino);
    this.log('info', 'backup', `Dump gerado: ${(st.size / 1024 / 1024).toFixed(2)} MB.`);
  }

  /* ----------------------------- etapa 4 ------------------------------- */

  async etapaCriptografia() {
    const p = this.params;
    this.log('info', 'criptografia', 'Criptografando com AES-256-GCM (scrypt)…');
    // O dump em claro será removido: é temporário.
    this.temporarios.push(this.arquivoAtual);
    const saida = await cripto.criptografarArquivo(this.arquivoAtual, p.chaveAes);
    // O arquivo em claro já foi removido pela função de criptografia.
    this.arquivoAtual = saida;
    // O .enc é temporário somente se houver compactação depois.
    if (p.compactar) this.temporarios.push(saida);
    this.log('info', 'criptografia', `Arquivo criptografado: ${saida}`);
  }

  /* ----------------------------- etapa 5 ------------------------------- */

  async etapaCompactacao() {
    const p = this.params;
    this.log('info', 'compactacao', 'Gerando ZIP protegido por senha (AES-256)…');
    // O arquivo atual (.enc ou dump) será removido: é temporário.
    this.temporarios.push(this.arquivoAtual);
    const saida = this.arquivoAtual + '.zip';

    const archiver = require('archiver');
    const archiverZipEncrypted = require('archiver-zip-encrypted');

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(saida);
      const archive = archiver.create('zip', {
        zlib: { level: 9 },
        encryptionMethod: 'aes256',
        password: p.senhaZip,
      });
      archive.on('error', reject);
      output.on('close', resolve);
      archive.pipe(output);
      archive.file(this.arquivoAtual, { name: path.basename(this.arquivoAtual) });
      archive.finalize();
    });

    // Remove o intermediário.
    fs.unlinkSync(this.arquivoAtual);
    this.arquivoAtual = saida;
    // O arquivo final NÃO é temporário: não é adicionado à lista de limpeza.
    this.log('info', 'compactacao', `ZIP gerado: ${saida}`);
  }

  /* ----------------------------- etapa 6 ------------------------------- */

  async etapaRetencao() {
    const p = this.params;
    this.log('info', 'retencao', `Aplicando retenção: manter ${p.quantidadeManter} arquivo(s) do padrão backup-${p.banco}-*.`);
    const r = retencao.aplicarRetencao(path.resolve(p.destino), p.banco, p.quantidadeManter);
    for (const nome of r.removidos) {
      this.log('info', 'retencao', `Removido por retenção: ${nome}`);
    }
    this.log('info', 'retencao', `Retenção concluída. Mantidos: ${r.mantidos.length}, removidos: ${r.removidos.length}.`);
  }

  /* ----------------------------- etapa 7 ------------------------------- */

  async etapaCopia() {
    const p = this.params;
    const destino = path.join(path.resolve(p.copiaAdicional), path.basename(this.arquivoAtual));
    this.log('info', 'copia', `Copiando para ${destino}…`);
    fs.copyFileSync(this.arquivoAtual, destino);

    // Verificação: tamanho e hash SHA-256.
    const h1 = crypto.createHash('sha256').update(fs.readFileSync(this.arquivoAtual)).digest('hex');
    const h2 = crypto.createHash('sha256').update(fs.readFileSync(destino)).digest('hex');
    const t1 = fs.statSync(this.arquivoAtual).size;
    const t2 = fs.statSync(destino).size;
    if (h1 !== h2 || t1 !== t2) {
      throw new Error(`Verificação da cópia falhou: hash/tamanho divergentes (${t1} vs ${t2} bytes).`);
    }
    this.log('info', 'copia', `Cópia verificada (SHA-256 idêntico, ${t2} bytes).`);
  }

  /* ----------------------------- etapa 8 ------------------------------- */

  async etapaFinalizacao(sucesso) {
    if (!sucesso) return;
    const duracao = ((Date.now() - new Date(this.inicio).getTime()) / 1000).toFixed(1);
    this.log('info', 'finalizacao', `Execução finalizada em ${duracao}s. Arquivo: ${this.arquivoAtual}`);
  }

  /* --------------------------- utilidades ------------------------------ */

  /**
   * Spawn com array de argumentos (nunca shell) e stderr mascarado.
   */
  spawnMascarado(cmd, args, { env } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { env: env || process.env, windowsHide: true });
      let stderr = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve();
        else {
          const saida = mascarar(stderr, this.segredos);
          reject(new Error(`Processo "${path.basename(cmd)}" saiu com código ${code}.${saida ? ' Saída: ' + saida : ''}`));
        }
      });
    });
  }
}

module.exports = { Executor, ETAPAS, ETAPAS_BLOQUEANTES };
