# Paytrack · Consulta de Cases

Ferramenta interna para consultar os 51 cases de clientes Paytrack via chat, com busca por setor/nome e logos das empresas.

## ⚠️ Antes de publicar fora do Claude

Este arquivo (`index.html`) foi criado como um artifact do Claude e usa dois recursos que **só existem dentro do ambiente do Claude**:

1. **`window.storage`** — usado para salvar a senha de acesso e permitir adicionar novos cases compartilhados entre todos. Fora do Claude, essas chamadas vão falhar silenciosamente.
2. **Chamada direta à API da Anthropic no chat** (`fetch("https://api.anthropic.com/v1/messages", ...)`) — hoje funciona sem expor uma chave porque o Claude injeta a autenticação por trás dos panos. **Se você publicar este HTML em outro lugar (Lovable, GitHub Pages, servidor próprio, etc.), essa chamada vai falhar ou, pior, exigir que você coloque uma chave de API direto no código — o que expõe a chave para qualquer visitante do site.**

## O que funciona sem alterações, hospedado fora do Claude

- Visualização dos 51 cases (nome, setor, logo, big number)
- Filtro por nome/setor na barra lateral
- Tela de senha (mas fixa no código, sem poder trocar por essa interface)

## O que **não** vai funcionar sem ajustes

- Adicionar novos documentos pela interface (dependia do `window.storage`)
- O chat com IA (dependia da infraestrutura do Claude)

## Para publicar de verdade, com o chat funcionando

Você vai precisar de um backend simples (ex: uma function serverless na Vercel/Netlify, ou um endpoint no seu próprio servidor) que:

1. Recebe a pergunta do usuário do frontend
2. Chama a API da Anthropic usando uma chave de API guardada como variável de ambiente no servidor (nunca no código do navegador)
3. Devolve a resposta pro frontend

Peça pra alguém de TI/dev da empresa ajudar nessa parte — é uma tarefa simples para quem já mexe com APIs, mas não deve ser feita expondo a chave no HTML.

## Rodando localmente

Basta abrir o `index.html` em qualquer navegador. A visualização dos cases funciona; senha e chat exigem os ajustes acima.
