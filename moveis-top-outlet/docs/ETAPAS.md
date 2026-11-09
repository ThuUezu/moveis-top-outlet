# Móveis Top Outlet: guia técnico por etapa

## Rodar localmente
1. Crie um banco PostgreSQL (Neon ou Supabase, plano gratuito) e copie a URL de conexão.
2. `cp apps/api/.env.example apps/api/.env` e preencha `DATABASE_URL`, `JWT_SECRET` (32+ caracteres) e os dados do Admin Master.
3. `npm install`
4. `cd apps/api && npx prisma migrate dev --name init` (cria as tabelas)
5. `npx prisma db execute --file prisma/audit_imutavel.sql --schema prisma/schema.prisma` (trava o log de auditoria)
6. `npm run seed` (cria o Admin Master e os parâmetros iniciais)
7. Em dois terminais, na raiz: `npm run dev:api` e `npm run dev:web` (web em http://localhost:5173)
8. Testes: `npm test`

O README completo de deploy (Netlify + Render + banco) vem na Etapa 10.

## Etapa 2 — catálogo
1. `npm install` (novas dependências) e, em `apps/api`, `npx prisma migrate dev --name catalogo`.
2. `npm run seed` agora também cria a árvore de categorias (pode rodar de novo sem duplicar).
3. Fotos e PDFs: crie um bucket no Cloudflare R2, preencha as variáveis `S3_*` no `.env` e, no bucket, libere CORS para o método PUT a partir do endereço do site.

## Etapa 3 — importação e exportação de produtos
1. `npm install` e, em `apps/api`, `npx prisma migrate dev --name importacao`.
2. Fluxo pela API (todas as rotas pedem login): `GET /imports/products/template` baixa o modelo → `POST /imports/products/preview` (arquivo no campo multipart) devolve o resumo e as linhas com aviso ou erro → `POST /imports/:id/confirm` com `{"modo":"CRIAR_E_ATUALIZAR","criarCadastros":true,"confirmarAvisos":true}` → `GET /imports/:id/report` baixa as linhas rejeitadas.
3. `GET /imports` lista o histórico; `POST /imports/:id/undo` (Admin Master) desfaz a última importação; `GET /exports/products?formato=xlsx|csv` exporta no mesmo formato do modelo.

## Etapa 4 — clientes (ficha completa, LGPD) e importação de clientes (10-B)
1. `npm install` e, em `apps/api`, `npx prisma migrate dev --name clientes`.
2. Ficha cadastral: `GET/POST/PATCH /customers`, `GET/DELETE /customers/:id` (usuário arquiva; Admin Master exclui definitivamente, com confirmação quando há vendas). Abas: `/customers/:id/addresses|contacts|bank|documents` (documentos vão para o S3/R2), `/customers/:id/credit`, `/customers/:id/history`, `/customers/:id/export` (LGPD). CEP automático: `GET /cep/:cep` (ViaCEP).
3. Filtro de campanha: `GET /customers/filters/purchased?produtoId=X&minQuantidade=N` (ativa com os dados da Etapa 6).
4. Importação: `GET /imports/customers/template` baixa o modelo (.xlsx com as abas **Clientes**, **Enderecos**, **Contatos**, ligadas pelo CPF/CNPJ) → `POST /imports/customers/preview` (multipart) → `POST /imports/:id/confirm` com `{"modo":"SOMENTE_CRIAR"|"CRIAR_E_ATUALIZAR"|"REVISAR", "confirmarAvisos":true, "decisoes":[{"linha":2,"decisao":"ATUALIZAR"}]}` (as `decisoes` só valem no modo REVISAR; a pré-visualização devolve as `mudancas` linha a linha). A confirmação processa em lotes de 250 e grava o progresso em `totals`, consultável por `GET /imports`. `POST /imports/:id/undo` (Admin Master) desfaz a última importação de clientes; `GET /imports/:id/report` baixa as linhas rejeitadas; `GET /exports/customers?formato=xlsx|csv` exporta no mesmo formato do modelo.
5. LGPD: listagens mascaram CPF/CNPJ, telefones e e-mails; acessos à ficha completa e a dados bancários vão para o log de auditoria; erros de importação nunca exibem o documento completo.
