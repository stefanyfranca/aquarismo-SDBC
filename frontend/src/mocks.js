export const mockExecucoes = [
  { id: 24, data_inicio: '2026-09-23T14:20:00', data_fim: '2026-09-23T14:23:18', status: 'sucesso', decisao_manutencao: 'NENHUMA', regra_aplicada: 'Última manutenção há 12 dias (< 30).', resultado: 'Backup concluído: backup-aquarismo_sdbc-2026-09-23.dump', banco: 'aquarismo_sdbc' },
  { id: 23, data_inicio: '2026-09-21T08:00:00', data_fim: '2026-09-21T08:06:42', status: 'sucesso', decisao_manutencao: 'VACUUM', regra_aplicada: 'Última manutenção há 43 dias (entre 30 e 60).', resultado: 'Backup concluído: backup-aquarismo_sdbc-2026-09-21.zip', banco: 'aquarismo_sdbc' },
  { id: 22, data_inicio: '2026-09-19T16:45:00', data_fim: null, status: 'em_andamento', decisao_manutencao: 'VACUUM_FULL_ANALYZE', regra_aplicada: 'Sem histórico de manutenção com data válida.', resultado: 'Execução em andamento.', banco: 'aquarismo_sdbc' },
  { id: 21, data_inicio: '2026-09-18T10:10:00', data_fim: '2026-09-18T10:12:07', status: 'falha', decisao_manutencao: 'NENHUMA', regra_aplicada: 'Última manutenção há 8 dias (< 30).', resultado: 'Execução interrompida por falha. Consulte os logs da execução.', banco: 'aquarismo_sdbc' }
];

export const mockLogs = [
  { execucao_id: 24, etapa: 'Compactação', mensagem: 'Compactando backup em ZIP protegido.', data: '2026-09-23T14:22:40', saida_tecnica: 'gzip: processando aquarismo.sql' },
  { execucao_id: 24, etapa: 'Verificação', mensagem: 'Integridade do arquivo confirmada.', data: '2026-09-23T14:22:54', saida_tecnica: 'sha256 verified: 4bd9...8ac2' },
  { execucao_id: 24, etapa: 'Criação', mensagem: 'Backup finalizado no destino principal.', data: '2026-09-23T14:23:18', saida_tecnica: 'backup-aquarismo_sdbc-2026-09-23.zip' },
  { execucao_id: 22, etapa: 'Validação', mensagem: 'Validando conexão e diretórios autorizados.', data: '2026-09-19T16:45:08', saida_tecnica: 'connection accepted' },
  { execucao_id: 21, etapa: 'Backup', mensagem: 'Não foi possível gravar o arquivo de backup.', data: '2026-09-18T10:12:07', saida_tecnica: 'ERROR: No space left on device' }
];

export const mockConfig = { banco: 'aquarismo_sdbc', destino: 'C:\\backups\\principal', qtd_manter: 7, caminho_copia_adicional: 'C:\\backups\\copia', criptografia: false, compactacao: true };
