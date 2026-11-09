# Móveis Top Outlet

Sistema de gestão para uma loja de móveis (projeto real), com API em Node.js/TypeScript e painel web em React. O projeto foi planejado em 10 etapas; as etapas 1 a 4 estão concluídas.

## Status

| Etapa | Tema | Situação |
|---|---|---|
| 1 | Login, perfis de acesso, 2FA e log de auditoria | Concluída |
| 2 | Catálogo (categorias, produtos, fotos e PDFs) | Concluída |
| 3 | Importação e exportação de produtos por planilha | Concluída |
| 4 | Clientes (ficha completa, LGPD) e importação de clientes | Concluída |
| 5 a 10 | Demais módulos do plano (a etapa 10 traz o guia completo de deploy) | Planejadas |

Limites conhecidos desta versão:

- A importação por planilha (produtos e clientes) está implementada na API e tem testes automatizados das regras de validação, mas ainda não foi validada com planilhas reais em grande volume.
- No painel web existem, por enquanto, as telas de login (com 2FA) e de Clientes. O catálogo e as importações são usados pela API.

## Tecnologias

- **API:** Node.js, TypeScript, Fastify, Prisma ORM, PostgreSQL, Zod
- **Segurança:** JWT com refresh token, 2FA (TOTP), hash de senha com Argon2, rate limit, Helmet
- **Arquivos e planilhas:** armazenamento compatível com S3 (Cloudflare R2), ExcelJS
- **Web:** React, Vite, Tailwind CSS
- **Testes:** Vitest

## O que o sistema faz

- **Acesso:** perfis Admin Master e usuário comum; o Admin Master é criado por seed, nunca por cadastro na tela; 2FA ativado no primeiro login.
- **Auditoria:** log de auditoria imutável (trigger no PostgreSQL bloqueia UPDATE e DELETE).
- **Catálogo:** árvore de categorias, produtos, variações, kits, fornecedores, fotos e PDFs.
- **Importação e exportação de produtos:** modelo `.xlsx`, pré-visualização com avisos e erros por linha, confirmação, relatório das linhas rejeitadas, desfazer a última importação e exportação em XLSX ou CSV.
- **Clientes:** ficha cadastral com endereços, contatos, dados bancários, documentos e crédito; busca de CEP automática (ViaCEP); histórico e exportação dos dados do cliente (LGPD).
- **Importação de clientes:** planilha com 3 abas ligadas por CPF/CNPJ (Clientes, Endereços e Contatos), validação de CPF/CNPJ, duplicidades e endereços linha a linha, processamento em lotes de 250 e relatório de erros.
- **LGPD:** listagens mascaram CPF/CNPJ, telefones e e-mails; acessos à ficha completa e a dados bancários vão para o log de auditoria; erros de importação nunca exibem o documento completo.

## Estrutura

```text
moveis-top-outlet/
├── apps/
│   ├── api/                 API (Fastify + Prisma)
│   │   ├── prisma/          schema.prisma e audit_imutavel.sql
│   │   └── src/             rotas, regras, importações e testes (*.test.ts)
│   └── web/                 painel (React + Vite)
├── docs/ETAPAS.md           guia técnico de cada etapa (rotas e fluxos)
└── package.json             workspaces npm
```

## Como rodar localmente

Pré-requisitos: Node.js 20 ou superior e um banco PostgreSQL (Neon ou Supabase, plano gratuito).

1. Instale as dependências, na raiz do projeto:
   `npm install`
2. Crie o arquivo de ambiente da API a partir do exemplo e preencha os valores:
   `cp apps/api/.env.example apps/api/.env` (no Windows: `copy apps\api\.env.example apps\api\.env`)
   Use um `JWT_SECRET` com 32 ou mais caracteres e uma senha de Admin Master com 10 ou mais.
3. Crie as tabelas:
   `cd apps/api` e depois `npx prisma migrate dev`
4. Ative o log de auditoria imutável:
   `npx prisma db execute --file prisma/audit_imutavel.sql --schema prisma/schema.prisma`
5. Crie o Admin Master, as configurações iniciais e as categorias:
   `npm run seed`
6. Em dois terminais, na raiz do projeto:
   `npm run dev:api` (API em http://localhost:3333)
   `npm run dev:web` (painel em http://localhost:5173)

No primeiro login do Admin Master o sistema pede a ativação do 2FA com um aplicativo autenticador.

O guia por etapa, com todas as rotas e fluxos de importação, está em [docs/ETAPAS.md](docs/ETAPAS.md).

## Testes

```bash
npm test
```

Os testes (Vitest) cobrem validação de CPF/CNPJ, regras do catálogo, importação de produtos e de clientes e funções de segurança.

## Transparência

Parte da camada de segurança (login, 2FA e log de auditoria) foi implementada com apoio de IA.

## Próximos passos

As etapas 5 a 10 ainda serão desenvolvidas. O guia completo de deploy (Netlify, Render e banco) está previsto para a etapa 10.

## Autor

**Arthur Uezu da Cruz**: [LinkedIn](https://www.linkedin.com/in/arthuruezu) · [GitHub](https://github.com/ThuUezu)

Este é um projeto real de uma loja. O código está publicado para fins de portfólio; todos os direitos reservados.
