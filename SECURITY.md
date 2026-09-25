# Segurança

## Como relatar uma vulnerabilidade

**Não abra uma issue pública para relatar uma falha de segurança.**

Use o relato privado do GitHub: na aba **Security** deste repositório, clique em **Report a vulnerability**. Só os mantenedores veem o relato até a correção ser publicada.

Inclua, se possível:

- a versão da Nova IDE e do sistema operacional;
- o que a falha permite fazer e em que situação;
- os passos para reproduzir (ou uma prova de conceito);
- se a falha também existe no [VS Code](https://github.com/microsoft/vscode) original.

Vamos confirmar o recebimento e combinar com você o prazo da correção e da divulgação.

## Falhas que vêm do VS Code

A Nova IDE é baseada no Code - OSS. Se a falha estiver em código que veio do VS Code e também existir lá, relate-a também à Microsoft, conforme a [política de segurança dela](https://aka.ms/SECURITY.md). Aqui cuidamos de trazer a correção para a Nova.

## Antivírus

O alerta de antivírus sobre o arquivo `runtime.node` do agente Copilot é um falso positivo conhecido. Veja o aviso no [README](README.md#aviso-antivírus-e-falso-positivo-no-runtimenode).

---

## Reporting a vulnerability (English)

Please do not open public issues for security problems. Use GitHub's private reporting (**Security** tab → **Report a vulnerability**). If the issue also exists in upstream VS Code, please report it to Microsoft as well (https://aka.ms/SECURITY.md).
