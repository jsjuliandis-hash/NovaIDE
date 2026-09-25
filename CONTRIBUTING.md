# Como contribuir com a Nova IDE

Obrigado pelo interesse! Bugs, ideias, traduções e pull requests são bem-vindos.

## Dúvidas, bugs e ideias

- Procure nas [issues](https://github.com/jsjuliandis-hash/NovaIDE/issues) antes de abrir uma nova, para evitar duplicatas.
- Para bugs, diga a versão da Nova IDE, o sistema operacional, os passos para reproduzir e o que você esperava que acontecesse. Prints ajudam muito.
- Falhas de segurança **não** vão em issue pública: veja o [SECURITY.md](SECURITY.md).
- Se o problema também acontece no VS Code original, ele provavelmente vem de lá. Vale relatar também no [repositório da Microsoft](https://github.com/microsoft/vscode/issues).

## Preparar o ambiente

Os requisitos e os comandos para compilar e abrir a IDE em desenvolvimento estão no [README](README.md#compilar-a-partir-do-código).

## Convenções do código

A Nova IDE é um fork do Code - OSS e recebe as atualizações dele. Para que isso continue fácil:

- **Lógica nova em extensões embutidas** (`extensions/nova-*`) sempre que possível.
- **Toda alteração em arquivo que veio do VS Code leva o comentário `// NOVA`**, na linha alterada ou num comentário logo acima do bloco. Arquivos novos da Nova não precisam da marca.
- Siga o estilo do código ao redor: tabs para indentar, textos visíveis ao usuário com `localize(...)`. As traduções pt-BR das mensagens novas ficam em `src/vs/base/common/novaNls.ts`, na seção do módulo (caminho do arquivo) que usa a mensagem.
- As orientações gerais do código do VS Code valem aqui também (veja `.github/copilot-instructions.md`).

## Testar

Antes do pull request, rode pelo menos:

```powershell
npm run typecheck-client                          # checagem de tipos de src/
scripts\test.bat --grep "<nome do teste ou suíte>"   # testes unitários do que você mudou
```

Mudanças visuais: inclua um print ou um GIF no pull request.

## Commits e pull requests

- Mensagens de commit no formato `tipo(área): descrição`, em português, por exemplo `fix(chat): ...`, `feat(tts): ...`, `docs: ...`.
- Um assunto por pull request. Descreva o que muda e como testar.

## Licença das contribuições

A Nova IDE é distribuída sob a [GPL-3.0-or-later](LICENSE.txt). Ao enviar uma contribuição, você concorda que ela seja distribuída sob essa mesma licença. As partes que vêm do VS Code continuam sob a licença MIT da Microsoft ([LICENSE-VSCODE-MIT.txt](LICENSE-VSCODE-MIT.txt)).

---

## Contributing (English)

Issues and pull requests are welcome, in English or Portuguese. Keep new logic in built-in `extensions/nova-*` when possible, mark every change to files inherited from VS Code with a `// NOVA` comment, and run `npm run typecheck-client` plus the relevant unit tests before opening a pull request. Contributions are licensed under GPL-3.0-or-later. Security issues: see [SECURITY.md](SECURITY.md).
