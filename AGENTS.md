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
- **Scroll Fixo no Fundo (Sticky Tail)**: O feed é uma coluna invertida de scroll, então o turno mais novo fica no fundo e acompanha o streaming nativamente. Rolar para cima congela a janela de leitura (mensagens novas não movem a tela); o pill "Scroll to end" volta ao fim e "Load earlier messages" pagina turnos antigos. Só uma janela limitada de linhas é construída, mantendo sessões longas baratas.
- **Status em Tempo Real & Controles de Painel**: Mostra o badge de status do agente (`working` com spinner, `blocked` "Needs you", `done`, `error`, `idle`), branch Git, diretório atual e botões rápidos para `Peek` (`pane.peek`), `Focus` (`terminal.focus`) e cópia de respostas (`cx.write_to_clipboard`).
- **Polling só Quando Visível**: O Herdr mantém os timers de uma cópia oculta (outra tab, settled, atrás de um zoom). O mod checa `window().active`, `focused()` e `panes()` a cada segundo e só lê transcript/`hc read` quando o pane está realmente na tela; cópias ocultas não gastam CPU nem I/O e o spinner de `working` fica estático.
- **Ações Rápidas de Aprovação**: Quando o agente está em estado de espera (`blocked`), exibe botões contextuais imediatos: `Approve (Enter)`, `Yes (y)`, `No (n)`, `Cancel (Esc)` disparando `hc keys` ou `hc send`.
- **Interação Bidirecional & Interrupção**: O compositor é um `Textarea` multi-linha: **Enter envia** a mensagem via `hc send <terminal> <text>` e **Shift+Enter quebra a linha** (o `submit` chega com `event.shift`). O botão **Stop** interrompe execuções em andamento via `hc interrupt <terminal>`.
- **Seletor de Modelo**: Claude usa os comandos `/model <id>` e `/effort <nível>`, com a mesma lista do picker nativo (Default, Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5; "More models…" abre o `/model` nativo) e os cinco níveis `low`/`medium`/`high`/`xhigh`/`max`. As trocas viram avisos no feed (lidos do `<local-command-stdout>` do transcript) e atualizam o modelo atual na hora; antes da primeira resposta o modelo vem do banner da tela. Uma sessão Claude recém-aberta (sem `.jsonl` ainda, e às vezes sem `app` reportado — usa `program.key`) mostra o estado vazio em vez do banner/placeholder; o OpenCode é lido e trocado pela API do próprio servidor — `opencode api GET /api/model` e `/api/provider` montam a lista agrupada por provider (o provider do modelo atual vem primeiro), e `POST /api/session/<sessionID>/model` troca o modelo da sessão ativa (o `sessionID` vem do `OpenCodeTranscript`). No OpenCode o **effort é a `variant` do modelo**: a coluna de effort lista as `variants` do modelo atual e troca pela mesma chamada (`{ model: { id, providerID, variant } }`); não existe `/effort`, digitar isso enviaria uma mensagem. A fonte da verdade do modelo atual é a linha `session_v2` (uma troca aparece nela antes de existir nova resposta); sem sessão ainda, o modelo é lido da tela do TUI. Se a API não estiver disponível, cai no picker nativo do terminal (`/models`).
- **Pensamento, ferramentas e avisos**: cada pensamento é uma linha recolhível (ícone de cérebro + resumo) cujo corpo é Markdown num painel limitado; cada chamada de ferramenta também abre sozinha, com a saída dobrada por padrão. Uma sequência de pensamentos e ferramentas vira uma seção ("Worked for 12s · Ran 3 commands…"; falhas aparecem como a etiqueta "N failed", não pintam o cabeçalho). Erros do provedor (`error.message`), interrupções, trocas de modelo e compactações viram uma linha discreta no turno (`noticeItem` em `opencode-data.js`). Mensagens entre agentes (`<hc from="tX">…</hc>`) são desembrulhadas e mostram "from tX".
- **Texto das respostas**: a fonte padrão de UI (Geist) não tem negrito/itálico aqui, então o corpo do feed usa a primeira família instalada de `body-font.js` (Inter, SF Pro Text, Helvetica Neue, Arial). O `TextView.markdown` nativo não desenha imagens nem colore diffs e não aceita estilos; linhas só com imagem viram uma linha de anexo (alt + caminho), já que o host só carrega imagens da própria pasta do app.

## Demo e inspeção visual

`demo-blocks.js` tem uma conversa fixa com todos os elementos (títulos, listas, tabela, citação, código, tarefas, erros). Abre sem agente, em aba própria:

```sh
herdr-app do tab.new --name "Chat demo" --mod agent-chat --props '{"demo":"opencode"}'
```

Props de inspeção: `demo` (`opencode` agrupa por turno, `claude` agrupa sequências), `part` (`a`, `b`, `short`, `edge`: partes do Markdown), `expand` (abre seções, pensamentos e ferramentas), `open` (`model` ou `agent`: já abre o seletor). Depois `herdr-app shot arquivo.png` salva o frame da janela. O chat só lê o transcript com a janela do Herdr ativa; com outro app em primeiro plano ele fica parado, de propósito.

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
