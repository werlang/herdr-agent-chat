# herdr-agent-chat

Fonte da verdade do mod `agent-chat`: um Chat UI nativo dentro do Herdr para acompanhar, inspecionar e conversar com agentes de codificação CLI (Claude Code, Antigravity, OpenCode, Codex, Aider, etc.).

## Regra: sempre atualizar a pasta live do Herdr

O Herdr lê os mods de `~/.config/herdr-app/mods/<nome>`. Depois de **qualquer** mudança aqui:

```sh
./sync.sh
```

O script copia `mods/agent-chat` para a pasta live e roda `herdr-app check`. Não edite a pasta live diretamente.

## Como funciona

O mod `agent-chat` conecta diretamente ao terminal do agente (`$HC_TERMINAL_ID`):

- **Seletor de Agentes & Follow Mode**: Permite alternar entre qualquer agente ou sub-agente ativo (na space atual ou em outras spaces), criar novos agentes (`hc spawn claude`) ou seguir automaticamente o agente focado (`followFocused`).
- **Alternância de Visão (Chat View vs. Original View)**: Botão seletor no topo para alternar instantaneamente entre o feed visual formatado e o stream original do terminal com contagem de linhas e botão de cópia integral.
- **Leitura do Stream & Cache de Histórico**: Faz polling via `hc read <terminal> --lines 200 --json`, preservando turnos anteriores em cache quando `hc read` retorna apenas a tela visível (`complete: false`) durante o estado `working`, e parseia o fluxo (`parser.js`) em turnos de usuário, pensamento (*thought*), invocações/grupos de ferramentas (*tool* / *tool_group*) e respostas do assistente em Markdown nativo (`TextView.markdown`).
- **Status em Tempo Real & Controles de Painel**: Mostra o badge de status do agente (`working` com spinner, `blocked` "Needs you", `done`, `error`, `idle`), branch Git, diretório atual e botões rápidos para `Peek` (`pane.peek`), `Focus` (`terminal.focus`) e cópia de respostas (`cx.write_to_clipboard`).
- **Ações Rápidas de Aprovação**: Quando o agente está em estado de espera (`blocked`), exibe botões contextuais imediatos: `Approve (Enter)`, `Yes (y)`, `No (n)`, `Cancel (Esc)` disparando `hc keys` ou `hc send`.
- **Interação Bidirecional & Interrupção**: O compositor é um `Textarea` multi-linha: **Enter envia** a mensagem via `hc send <terminal> <text>` e **Shift+Enter quebra a linha** (o `submit` chega com `event.shift`). O botão **Stop** interrompe execuções em andamento via `hc interrupt <terminal>`.
- **Seletor de Modelo**: Claude usa os comandos `/model` e `/effort`; o OpenCode é lido e trocado pela API do próprio servidor — `opencode api GET /api/model` e `/api/provider` montam a lista agrupada por provider, e `POST /api/session/<sessionID>/model` troca o modelo da sessão ativa (o `sessionID` vem do `OpenCodeTranscript`). Se a API não estiver disponível, cai no picker nativo do terminal (`/models`).

## Como abrir no Herdr

### Dividir painel ao lado do terminal (Split)
```sh
herdr-app do pane.split --direction right --mod agent-chat
```
Ou especificando o terminal de destino:
```sh
herdr-app do pane.split --direction right --mod agent-chat --props '{"terminal":"t2n"}'
```

### Abrir em uma nova aba
```sh
herdr-app do tab.new --name "Agent Chat" --mod agent-chat
```

## Skill

A skill `herdr-publish` está em `.agents/skills/herdr-publish/SKILL.md`. Ela cobre validação, sync, `RECIPE.md`/`preview.png` e publicação em `herdr.dev/mods` com o tópico `herdr-mod`.
