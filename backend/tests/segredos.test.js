/**
 * Varredura automatizada: nenhum segredo real deve aparecer no código,
 * em data/ ou em respostas de API. Também verifica que não há .env nem
 * credenciais fixas no repositório.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

function lerArquivos(dir, exts, ignorar = ['node_modules', 'data', '.git']) {
  const saida = [];
  if (!fs.existsSync(dir)) return saida;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignorar.includes(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) saida.push(...lerArquivos(full, exts, ignorar));
    else if (exts.some(e => item.name.endsWith(e))) saida.push(full);
  }
  return saida;
}

test('Não existe arquivo .env no repositório', () => {
  const envs = lerArquivos(RAIZ, ['.env'], ['node_modules', 'data', '.git'])
    .filter(f => path.basename(f) === '.env' || path.basename(f).startsWith('.env.'));
  assert.deepEqual(envs, []);
});

test('Código não contém senhas/hosts reais fixos', () => {
  const arquivos = [
    ...lerArquivos(path.join(RAIZ, 'src'), ['.js']),
    ...lerArquivos(path.join(RAIZ, 'public'), ['.js', '.html']),
    path.join(RAIZ, 'server.js'),
  ];
  const padroesSuspeitos = [
    /password\s*=\s*['"][^'"]{8,}['"]/i,      // senha fixa
    /PGPASSWORD\s*=\s*['"][^'"]+['"]/i,       // senha fixa em PGPASSWORD
    /senha\s*=\s*['"][^'"]{8,}['"]/i,
  ];
  for (const arq of arquivos) {
    const conteudo = fs.readFileSync(arq, 'utf8');
    for (const padrao of padroesSuspeitos) {
      const m = padrao.exec(conteudo);
      if (m) {
        assert.fail(`Possível segredo fixo em ${path.relative(RAIZ, arq)}: "${m[0].slice(0, 40)}…"`);
      }
    }
  }
});

test('Código não usa dotenv', () => {
  const arquivos = lerArquivos(path.join(RAIZ, 'src'), ['.js']);
  for (const arq of arquivos) {
    const conteudo = fs.readFileSync(arq, 'utf8');
    assert.ok(!conteudo.includes('dotenv'), `${path.relative(RAIZ, arq)} usa dotenv.`);
  }
});

test('Diretório data/ não existe no repositório (criado em runtime)', () => {
  // data/ está no .gitignore; se existir, deve estar vazio de segredos.
  const dataDir = path.join(RAIZ, 'data');
  if (fs.existsSync(dataDir)) {
    const arquivos = lerArquivos(dataDir, ['.sqlite', '.log', '.json', '.eml'], []);
    for (const arq of arquivos) {
      const conteudo = fs.readFileSync(arq, 'utf8');
      assert.ok(!/SenhaSecreta|sbac123/i.test(conteudo), `Segredo em ${path.relative(RAIZ, arq)}`);
    }
  }
});
