# Nova IDE

[![Licença: GPL-3.0](https://img.shields.io/badge/licen%C3%A7a-GPL--3.0-blue)](LICENSE.txt)
[![Apoie via Pix](https://img.shields.io/badge/apoie-via%20Pix-32BCAD?logo=pix&logoColor=white)](https://livepix.gg/juliandis)

A **Nova IDE** é um editor de código baseado no [Code - OSS](https://github.com/microsoft/vscode) (o código aberto do VS Code), feito para trabalhar com agentes de IA. O navegador integrado que você vê pode ser controlado pelos agentes. Assim o ciclo fecha: **o agente edita o código → a página atualiza → o agente vê o resultado → corrige**. A interface vem em português do Brasil.

## Recursos

- **Navegador integrado para agentes.** O mesmo navegador que aparece na IDE fica disponível por um servidor MCP local, uma API REST, a CLI `nova-browser` e um endpoint CDP compatível com o Playwright (`connectOverCDP`). O acesso é só local, com token, e a navegação é limitada a `localhost` por padrão.
- **Dev server automático.** Ao abrir um projeto frontend (Vite, Next, Angular...), a IDE sobe o servidor de desenvolvimento e abre o `localhost` no navegador integrado.
- **Agentes externos no Chat.** OpenCode, Claude Code, Codex CLI e Gemini CLI conversam pelo painel de Chat via Agent Client Protocol, com seletor de modelo, busca e favoritos. Cada agente recebe um manual da IDE para abrir arquivos, imagens e diffs no próprio editor.
- **Abas de chat simultâneas.** Várias sessões rodando ao mesmo tempo, cada uma com seu modelo. Por exemplo, um modelo forte planeja e um gratuito executa. Os logos das empresas aparecem ao lado dos modelos.
- **Ditado por voz.** Microfone com a sua própria chave do Groq ou do Gemini, e modo "apertar para falar" (segure `Alt+Q`, solte para enviar).
- **Leitura das respostas em voz alta.** O padrão é a voz local Piper, offline e grátis. Azure, Google, ElevenLabs e Amazon Polly funcionam com a sua chave. A fala automática pode ser ligada em cada aba de chat separadamente.

## Instalar

O instalador para **Windows x64** será publicado na página de [Releases](https://github.com/jsjuliandis-hash/NovaIDE/releases). Linux e macOS ainda não têm build oficial.

## Compilar a partir do código

Requisitos (Windows 10/11 x64):

- **Node.js 24.18.0** (versão do `.nvmrc`; com o nvm-windows: `nvm install 24.18.0` e `nvm use 24.18.0`);
- **Visual Studio 2022 Build Tools** com a carga "Desenvolvimento para desktop com C++" e o componente **Spectre-mitigated libs**;
- **Python 3**;
- Git com `core.autocrlf false` e `core.longpaths true`;
- a pasta do repositório num caminho **sem espaços nem acentos** (ex.: `C:\dev\NovaIDE`);
- 16 GB de RAM recomendados.

```powershell
npm ci
npm run electron                 # baixa o Electron
npm run gulp copy-codicons
npm run compile                  # ou "npm run watch" durante o desenvolvimento
node build/nova/devNls.ts pt-br  # traduções pt-BR do modo de desenvolvimento
scripts\nova-dev.bat <pasta-do-projeto>
```

Use sempre o `scripts\nova-dev.bat` com uma pasta para abrir a IDE em desenvolvimento. Ele prepara o ambiente e, sem pasta, a janela abre vazia.

## Contribuir

Bugs, ideias e pull requests são bem-vindos nas [issues](https://github.com/jsjuliandis-hash/NovaIDE/issues) deste repositório. Duas convenções mantêm a Nova fácil de atualizar com o VS Code:

- de preferência, a lógica nova fica em extensões embutidas (`extensions/nova-*`);
- toda alteração em arquivo que veio do VS Code leva o comentário `// NOVA`.

## Apoie o projeto

A Nova IDE é gratuita e de código aberto. Se ela te ajuda, uma doação via Pix sustenta o desenvolvimento:

[![Apoie via Pix no Live Pix](https://img.shields.io/badge/Doar%20via%20Pix-Live%20Pix-32BCAD?style=for-the-badge&logo=pix&logoColor=white)](https://livepix.gg/juliandis)

A IDE também mostra esse convite ao abrir. Quem preferir pode desligá-lo na configuração `nova.donation.showOnStartup` e abrir quando quiser pelo comando **Apoiar a Nova IDE**.

## Licença e créditos

- A Nova IDE é distribuída sob a [GNU GPL 3.0](LICENSE.txt).
- Baseada no [Code - OSS](https://github.com/microsoft/vscode), © Microsoft Corporation, licença MIT ([LICENSE-VSCODE-MIT.txt](LICENSE-VSCODE-MIT.txt)). Avisos de componentes de terceiros em [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
- Logos das empresas dos modelos: [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT) e [simple-icons](https://github.com/simple-icons/simple-icons) (CC0). Veja [LOGOS-LICENSE.txt](extensions/nova-agent-bridge/media/LOGOS-LICENSE.txt).
- Voz local: [Piper](https://github.com/rhasspy/piper) (MIT), baixado na primeira vez que é usado.

A Nova IDE não é afiliada à Microsoft. "Visual Studio Code" e "VS Code" são marcas da Microsoft Corporation.

---

## English

**Nova IDE** is a code editor based on Code - OSS, built for AI agents. The integrated browser you see is exposed to agents through a local MCP server, a REST API, a CLI and a CDP endpoint, so an agent can edit code, look at the page and fix it. Nova IDE also runs external agents in the Chat view (OpenCode, Claude Code, Codex CLI, Gemini CLI) in parallel tabs, with voice dictation and read-aloud. The UI defaults to Brazilian Portuguese. Licensed under GPL-3.0. If Nova IDE helps you, you can [support it via Pix](https://livepix.gg/juliandis).
